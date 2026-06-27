import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachAbortKill } from '@src/integration/ai/providers/_engine/abort-kill.ts';
import { DEFAULT_GRACE_MS } from '@src/integration/ai/providers/_engine/idle-watchdog.ts';

/**
 * Minimal fake child exposing only the surface `attachAbortKill` touches: a `kill` method that
 * records the signal so tests can assert the SIGTERM → SIGKILL ladder fired in order.
 */
const makeFakeChild = (): { readonly child: ChildProcess; readonly kills: string[] } => {
  const kills: string[] = [];
  const child = {
    kill: (sig: NodeJS.Signals): boolean => {
      kills.push(String(sig));
      return true;
    },
  } as unknown as ChildProcess;
  return { child, kills };
};

describe('attachAbortKill', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends SIGTERM on abort, then SIGKILL after the grace window', () => {
    const { child, kills } = makeFakeChild();
    const controller = new AbortController();
    attachAbortKill(child, controller.signal);

    controller.abort();
    expect(kills).toEqual(['SIGTERM']);

    vi.advanceTimersByTime(DEFAULT_GRACE_MS - 1);
    expect(kills).toEqual(['SIGTERM']);
    vi.advanceTimersByTime(1);
    expect(kills).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('kills immediately when the signal is already aborted at attach time', () => {
    const { child, kills } = makeFakeChild();
    const controller = new AbortController();
    controller.abort();

    attachAbortKill(child, controller.signal);
    expect(kills).toEqual(['SIGTERM']);
    vi.advanceTimersByTime(DEFAULT_GRACE_MS);
    expect(kills).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('cleanup cancels the pending SIGKILL escalation after a clean exit', () => {
    const { child, kills } = makeFakeChild();
    const controller = new AbortController();
    const cleanup = attachAbortKill(child, controller.signal);

    controller.abort(); // SIGTERM fired, grace timer armed
    expect(kills).toEqual(['SIGTERM']);
    cleanup(); // child exited before the grace window elapsed
    vi.advanceTimersByTime(DEFAULT_GRACE_MS * 2);
    expect(kills).toEqual(['SIGTERM']); // no SIGKILL against a dead pid
  });

  it('cleanup removes the abort listener so a reused AbortController collects no dead handlers', () => {
    const { child } = makeFakeChild();
    const controller = new AbortController();
    const signal = controller.signal;
    const adds: EventListener[] = [];
    const removes: EventListener[] = [];
    const origAdd = signal.addEventListener.bind(signal);
    const origRemove = signal.removeEventListener.bind(signal);
    signal.addEventListener = ((type: string, listener: EventListener, options?: AddEventListenerOptions) => {
      if (type === 'abort' && typeof listener === 'function') adds.push(listener);
      origAdd(type, listener, options);
    }) as typeof signal.addEventListener;
    signal.removeEventListener = ((type: string, listener: EventListener, options?: EventListenerOptions) => {
      if (type === 'abort' && typeof listener === 'function') removes.push(listener);
      origRemove(type, listener, options);
    }) as typeof signal.removeEventListener;

    const cleanup = attachAbortKill(child, signal);
    expect(adds).toHaveLength(1);

    cleanup();
    expect(removes).toHaveLength(1);
    expect(removes[0]).toBe(adds[0]);
  });

  it('no signal → cleanup is a no-op and the child is never killed', () => {
    const { child, kills } = makeFakeChild();
    const cleanup = attachAbortKill(child, undefined);
    expect(() => cleanup()).not.toThrow();
    vi.advanceTimersByTime(DEFAULT_GRACE_MS * 2);
    expect(kills).toEqual([]);
  });

  it('survives a child that already exited (kill throws ESRCH-style; swallowed)', () => {
    const kills: string[] = [];
    const child = {
      kill: (sig: NodeJS.Signals): boolean => {
        kills.push(String(sig));
        throw new Error('ESRCH: no such process');
      },
    } as unknown as ChildProcess;
    const controller = new AbortController();
    attachAbortKill(child, controller.signal);

    expect(() => {
      controller.abort();
      vi.advanceTimersByTime(DEFAULT_GRACE_MS);
    }).not.toThrow();
    expect(kills).toEqual(['SIGTERM', 'SIGKILL']);
  });
});
