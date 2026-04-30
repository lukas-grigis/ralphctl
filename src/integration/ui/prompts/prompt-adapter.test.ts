import { describe, it, expect, beforeEach } from 'vitest';
import { PromptCancelledError } from '../../../business/ports/prompt-port.ts';
import { promptQueue } from './prompt-queue.ts';

describe('PromptQueue', () => {
  beforeEach(() => {
    // Clear any leftover prompts from prior tests.
    const err = new PromptCancelledError('test teardown');
    promptQueue.clear(err);
  });

  it('starts empty', () => {
    expect(promptQueue.current()).toBeNull();
    expect(promptQueue.size()).toBe(0);
  });

  it('enqueues a confirm prompt', () => {
    promptQueue.enqueue({
      kind: 'confirm',
      options: { message: 'Are you sure?' },
      resolve: () => undefined,
      reject: () => undefined,
    });
    expect(promptQueue.size()).toBe(1);
    expect(promptQueue.current()?.kind).toBe('confirm');
  });

  it('resolveCurrent advances the queue', () => {
    let resolved: boolean | undefined;
    promptQueue.enqueue({
      kind: 'confirm',
      options: { message: 'first' },
      resolve: (v) => {
        resolved = v;
      },
      reject: () => undefined,
    });
    promptQueue.enqueue({
      kind: 'confirm',
      options: { message: 'second' },
      resolve: () => undefined,
      reject: () => undefined,
    });
    expect(promptQueue.size()).toBe(2);
    promptQueue.resolveCurrent(true);
    expect(resolved).toBe(true);
    expect(promptQueue.size()).toBe(1);
    expect(promptQueue.current()?.options.message).toBe('second');
  });

  it('cancelCurrent rejects the head promise', () => {
    let rejected: Error | undefined;
    promptQueue.enqueue({
      kind: 'input',
      options: { message: 'enter value' },
      resolve: () => undefined,
      reject: (e) => {
        rejected = e;
      },
    });
    const err = new PromptCancelledError('user pressed Esc');
    promptQueue.cancelCurrent(err);
    expect(rejected).toBe(err);
    expect(promptQueue.size()).toBe(0);
  });

  it('clear rejects all pending prompts', () => {
    const rejections: Error[] = [];
    for (let i = 0; i < 3; i++) {
      promptQueue.enqueue({
        kind: 'confirm',
        options: { message: `q${String(i)}` },
        resolve: () => undefined,
        reject: (e) => rejections.push(e),
      });
    }
    const reason = new PromptCancelledError('shutdown');
    promptQueue.clear(reason);
    expect(rejections).toHaveLength(3);
    expect(rejections.every((e) => e === reason)).toBe(true);
    expect(promptQueue.size()).toBe(0);
  });

  it('subscribe receives current on registration', () => {
    const events: (string | null)[] = [];
    promptQueue.enqueue({
      kind: 'confirm',
      options: { message: 'pending' },
      resolve: () => undefined,
      reject: () => undefined,
    });
    const unsub = promptQueue.subscribe((state) => {
      events.push(state.current?.kind ?? null);
    });
    // Called immediately with current
    expect(events).toHaveLength(1);
    expect(events[0]).toBe('confirm');
    promptQueue.resolveCurrent(true);
    expect(events[events.length - 1]).toBeNull();
    unsub();
  });

  it('listener errors do not stall delivery to other listeners', () => {
    const good: unknown[] = [];
    promptQueue.subscribe(() => {
      throw new Error('bad listener');
    });
    promptQueue.subscribe((state) => good.push(state.current));
    promptQueue.enqueue({
      kind: 'input',
      options: { message: 'test' },
      resolve: () => undefined,
      reject: () => undefined,
    });
    // Good listener still receives the event despite bad listener throwing
    expect(good.length).toBeGreaterThan(0);
  });

  it('multiple kinds queue independently', () => {
    const kinds: string[] = [];
    promptQueue.subscribe((state) => {
      if (state.current) kinds.push(state.current.kind);
    });
    promptQueue.enqueue({
      kind: 'select',
      options: { message: 'pick', choices: [] },
      resolve: () => undefined,
      reject: () => undefined,
    });
    promptQueue.enqueue({
      kind: 'checkbox',
      options: { message: 'multi', choices: [] },
      resolve: () => undefined,
      reject: () => undefined,
    });
    expect(kinds).toContain('select');
    promptQueue.resolveCurrent(null);
    expect(promptQueue.current()?.kind).toBe('checkbox');
  });
});
