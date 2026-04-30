import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Result } from 'typescript-result';

import { NotFoundError } from '../../domain/errors/not-found-error.ts';
import { IsoTimestamp } from '../../domain/values/iso-timestamp.ts';
import type { ElementResult, KernelError } from '../../kernel/chain/element.ts';
import { Element } from '../../kernel/chain/element.ts';
import { SessionManager } from './session-manager.ts';
import type { SessionManagerEvent } from './session-manager-port.ts';

interface Ctx {
  readonly value: number;
}

/** Resolves immediately with `Result.ok`. Used for fast-path tests. */
class SuccessElement extends Element<Ctx> {
  protected override run(ctx: Ctx): Promise<ElementResult<Ctx>> {
    return this.runLeaf(async () => Promise.resolve(Result.ok({ value: ctx.value + 1 })));
  }
}

/** Always fails with the given error. */
class FailureElement extends Element<Ctx> {
  constructor(
    name: string,
    private readonly err: KernelError = { code: 'boom', message: 'fail' }
  ) {
    super(name);
  }
  protected override run(): Promise<ElementResult<Ctx>> {
    return this.runLeaf(() => Promise.resolve(Result.error(this.err) as Result<Ctx, KernelError>));
  }
}

/**
 * Long-running element — sleeps until aborted. Resolves successfully on
 * abort so the runner reports `aborted` (the runner status machine flips
 * to 'aborted' when `abortRequested` is true regardless of the child's
 * outcome).
 */
class LongRunningElement extends Element<Ctx> {
  protected override run(ctx: Ctx, signal?: AbortSignal): Promise<ElementResult<Ctx>> {
    return this.runLeaf(
      () =>
        new Promise<Result<Ctx, KernelError>>((resolve) => {
          const timer = setTimeout(() => {
            resolve(Result.ok({ value: ctx.value + 1 }));
          }, 60_000);
          if (signal) {
            signal.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                resolve(Result.ok({ value: ctx.value + 1 }));
              },
              { once: true }
            );
          }
        }),
      signal
    );
  }
}

const FIXED_TS = IsoTimestamp.trustString('2026-04-29T12:00:00Z');

function makeManager(idSeq: string[] = []) {
  let i = 0;
  return new SessionManager({
    idGenerator: () => idSeq[i++] ?? `auto${String(i)}`,
    clock: () => FIXED_TS,
  });
}

/** Helper: dereference a descriptor that the test knows is present. */
function getDescriptor(manager: SessionManager, id: string) {
  const d = manager.get(id);
  if (!d) throw new Error(`expected descriptor for id=${id}`);
  return d;
}

describe('SessionManager', () => {
  beforeEach(() => {
    // ChainRunner / SessionManager warn on listener throws — silence the
    // expected ones in this suite.
    vi.spyOn(console, 'warn').mockImplementation(() => {
      /* expected */
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('start() registers a session, returns the generated id, and emits "added"', async () => {
    const manager = makeManager(['sess0001']);
    const events: SessionManagerEvent[] = [];
    manager.subscribe((e) => events.push(e));

    const id = manager.start({
      label: 'first',
      element: new SuccessElement('a'),
      initialCtx: { value: 0 },
    });

    expect(id).toBe('sess0001');
    expect(events).toEqual([{ type: 'added', sessionId: 'sess0001' }]);

    await manager.dispose();
  });

  it('list() preserves insertion order', async () => {
    const manager = makeManager(['s1', 's2', 's3']);
    manager.start({ label: 'first', element: new SuccessElement('a'), initialCtx: { value: 0 } });
    manager.start({ label: 'second', element: new SuccessElement('b'), initialCtx: { value: 0 } });
    manager.start({ label: 'third', element: new SuccessElement('c'), initialCtx: { value: 0 } });

    const ids = manager.list().map((d) => d.id);
    expect(ids).toEqual(['s1', 's2', 's3']);

    await manager.dispose();
  });

  it('get() returns the descriptor with the correct fields', async () => {
    const manager = makeManager(['abc12345']);
    const id = manager.start({
      label: 'my-session',
      element: new SuccessElement('a'),
      initialCtx: { value: 0 },
    });

    const descriptor = manager.get(id);
    expect(descriptor).toBeDefined();
    expect(descriptor?.id).toBe('abc12345');
    expect(descriptor?.label).toBe('my-session');
    expect(descriptor?.startedAt).toBe(FIXED_TS);
    expect(descriptor?.runner).toBeDefined();

    await manager.dispose();
  });

  it('get() returns undefined for an unknown id', () => {
    const manager = makeManager();
    expect(manager.get('does-not-exist')).toBeUndefined();
  });

  it('foreground() emits "active-changed" with the id', async () => {
    const manager = makeManager(['s1']);
    const events: SessionManagerEvent[] = [];

    const id = manager.start({
      label: 'first',
      element: new SuccessElement('a'),
      initialCtx: { value: 0 },
    });
    manager.subscribe((e) => events.push(e));

    const result = manager.foreground(id);
    expect(result.ok).toBe(true);
    expect(events).toEqual([{ type: 'active-changed', sessionId: 's1' }]);
    expect(manager.active?.id).toBe('s1');

    await manager.dispose();
  });

  it('foreground() of an unknown id returns NotFoundError', () => {
    const manager = makeManager();
    const result = manager.foreground('nope');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(NotFoundError);
      expect(result.error.entity).toBe('session');
      expect(result.error.id).toBe('nope');
    }
  });

  it('foreground() is a no-op when the session is already active (no extra event)', async () => {
    const manager = makeManager(['s1']);
    const id = manager.start({
      label: 'first',
      element: new SuccessElement('a'),
      initialCtx: { value: 0 },
    });
    manager.foreground(id);

    const events: SessionManagerEvent[] = [];
    manager.subscribe((e) => events.push(e));
    const result = manager.foreground(id);

    expect(result.ok).toBe(true);
    expect(events).toEqual([]);

    await manager.dispose();
  });

  it('background() while active emits "active-changed" with null', async () => {
    const manager = makeManager(['s1']);
    const id = manager.start({
      label: 'first',
      element: new SuccessElement('a'),
      initialCtx: { value: 0 },
    });
    manager.foreground(id);

    const events: SessionManagerEvent[] = [];
    manager.subscribe((e) => events.push(e));

    const result = manager.background(id);
    expect(result.ok).toBe(true);
    expect(events).toEqual([{ type: 'active-changed', sessionId: null }]);
    expect(manager.active).toBeNull();

    await manager.dispose();
  });

  it('background() while not active is a no-op (still Result.ok)', async () => {
    const manager = makeManager(['s1', 's2']);
    const id1 = manager.start({
      label: 'first',
      element: new SuccessElement('a'),
      initialCtx: { value: 0 },
    });
    const id2 = manager.start({
      label: 'second',
      element: new SuccessElement('b'),
      initialCtx: { value: 0 },
    });
    manager.foreground(id1);

    const events: SessionManagerEvent[] = [];
    manager.subscribe((e) => events.push(e));

    // s2 is not active — backgrounding it should be a no-op.
    const result = manager.background(id2);
    expect(result.ok).toBe(true);
    expect(events).toEqual([]);
    expect(manager.active?.id).toBe(id1);

    await manager.dispose();
  });

  it('background() of an unknown id returns NotFoundError', () => {
    const manager = makeManager();
    const result = manager.background('nope');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(NotFoundError);
    }
  });

  it('kill() with an unknown id returns NotFoundError', () => {
    const manager = makeManager();
    const result = manager.kill('nope');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(NotFoundError);
    }
  });

  it('kill() while running aborts the runner and removes the descriptor', async () => {
    const manager = makeManager(['s1']);
    const id = manager.start({
      label: 'long',
      element: new LongRunningElement('forever'),
      initialCtx: { value: 0 },
    });

    const events: SessionManagerEvent[] = [];
    manager.subscribe((e) => events.push(e));

    const runner = getDescriptor(manager, id).runner;

    const result = manager.kill(id);
    expect(result.ok).toBe(true);
    // Descriptor removed immediately.
    expect(manager.get(id)).toBeUndefined();
    expect(manager.list()).toHaveLength(0);
    expect(events).toEqual([{ type: 'removed', sessionId: id }]);

    // Runner reaches 'aborted' eventually — start() promise settles.
    await runner.start();
    expect(runner.status).toBe('aborted');

    await manager.dispose();
  });

  it('kill() of the active session emits both active-changed(null) and removed', async () => {
    const manager = makeManager(['s1']);
    const id = manager.start({
      label: 'long',
      element: new LongRunningElement('forever'),
      initialCtx: { value: 0 },
    });
    manager.foreground(id);

    const events: SessionManagerEvent[] = [];
    manager.subscribe((e) => events.push(e));

    manager.kill(id);
    expect(events).toEqual([
      { type: 'active-changed', sessionId: null },
      { type: 'removed', sessionId: id },
    ]);
    expect(manager.active).toBeNull();

    await manager.dispose();
  });

  it('subscribers receive all events in emission order', async () => {
    const manager = makeManager(['s1', 's2']);
    const events: SessionManagerEvent[] = [];
    manager.subscribe((e) => events.push(e));

    const id1 = manager.start({
      label: 'a',
      element: new SuccessElement('a'),
      initialCtx: { value: 0 },
    });
    const id2 = manager.start({
      label: 'b',
      element: new SuccessElement('b'),
      initialCtx: { value: 0 },
    });
    manager.foreground(id2);
    manager.background(id2);
    manager.kill(id1);

    expect(events).toEqual([
      { type: 'added', sessionId: 's1' },
      { type: 'added', sessionId: 's2' },
      { type: 'active-changed', sessionId: 's2' },
      { type: 'active-changed', sessionId: null },
      { type: 'removed', sessionId: 's1' },
    ]);

    await manager.dispose();
  });

  it('one subscriber throwing does not stall delivery to its peers', async () => {
    const manager = makeManager(['s1']);
    const seen: SessionManagerEvent[] = [];

    manager.subscribe(() => {
      throw new Error('bad listener');
    });
    manager.subscribe((e) => seen.push(e));

    manager.start({
      label: 'a',
      element: new SuccessElement('a'),
      initialCtx: { value: 0 },
    });

    expect(seen).toEqual([{ type: 'added', sessionId: 's1' }]);

    await manager.dispose();
  });

  it('unsubscribe() stops further delivery', async () => {
    const manager = makeManager(['s1', 's2']);
    const seen: SessionManagerEvent[] = [];
    const off = manager.subscribe((e) => seen.push(e));

    manager.start({
      label: 'a',
      element: new SuccessElement('a'),
      initialCtx: { value: 0 },
    });
    off();
    manager.start({
      label: 'b',
      element: new SuccessElement('b'),
      initialCtx: { value: 0 },
    });

    expect(seen).toEqual([{ type: 'added', sessionId: 's1' }]);

    await manager.dispose();
  });

  it('status mirrors runner lifecycle: idle → running → completed (success path)', async () => {
    const manager = makeManager(['s1']);
    const id = manager.start({
      label: 'a',
      element: new SuccessElement('a'),
      initialCtx: { value: 0 },
    });

    const runner = getDescriptor(manager, id).runner;
    await runner.start();

    expect(manager.get(id)?.status).toBe('completed');

    await manager.dispose();
  });

  it('status mirrors runner lifecycle: failed when the chain returns Result.error', async () => {
    const manager = makeManager(['s1']);
    const id = manager.start({
      label: 'a',
      element: new FailureElement('x'),
      initialCtx: { value: 0 },
    });

    const runner = getDescriptor(manager, id).runner;
    await runner.start();

    expect(manager.get(id)?.status).toBe('failed');

    await manager.dispose();
  });

  it('descriptor identity changes when status changes (snapshot semantics)', async () => {
    const manager = makeManager(['s1']);
    const id = manager.start({
      label: 'a',
      element: new SuccessElement('a'),
      initialCtx: { value: 0 },
    });

    const before = getDescriptor(manager, id);
    await before.runner.start();
    const after = manager.get(id);

    expect(before).not.toBe(after);
    expect(before.status).toBe('idle');
    expect(after?.status).toBe('completed');

    await manager.dispose();
  });

  it('dispose() aborts every live runner and clears subscribers', async () => {
    const manager = makeManager(['s1', 's2']);
    const id1 = manager.start({
      label: 'a',
      element: new LongRunningElement('a'),
      initialCtx: { value: 0 },
    });
    const id2 = manager.start({
      label: 'b',
      element: new LongRunningElement('b'),
      initialCtx: { value: 0 },
    });

    const r1 = getDescriptor(manager, id1).runner;
    const r2 = getDescriptor(manager, id2).runner;

    const seen: SessionManagerEvent[] = [];
    manager.subscribe((e) => seen.push(e));

    await manager.dispose();

    // Both runners reached terminal state.
    expect(r1.status).toBe('aborted');
    expect(r2.status).toBe('aborted');

    // Registry is empty.
    expect(manager.list()).toHaveLength(0);

    // Subscribers were cleared during dispose — post-dispose subscribe
    // returns a no-op unsubscribe and never receives events. (We can't
    // verify this directly because the manager is disposed; the next
    // assertion ensures the previously registered listener didn't see
    // any events DURING dispose either — dispose is silent by design.)
    expect(seen).toEqual([]);
  });

  it('kill() on an already-terminal (completed) session is a no-op — returns Result.ok, no event', async () => {
    // Legacy intent: process-supervisor termination edge case — kill after settle
    const manager = makeManager(['s1']);
    const id = manager.start({
      label: 'fast',
      element: new SuccessElement('a'),
      initialCtx: { value: 0 },
    });

    const runner = getDescriptor(manager, id).runner;
    await runner.start();
    // Runner is now completed — descriptor still lives in the registry.
    expect(manager.get(id)?.status).toBe('completed');

    const events: SessionManagerEvent[] = [];
    manager.subscribe((e) => events.push(e));

    const result = manager.kill(id);
    // kill() should succeed even on a terminal runner.
    expect(result.ok).toBe(true);
    // The session is removed.
    expect(manager.get(id)).toBeUndefined();
    // 'removed' event fires, but no 'active-changed' since it wasn't active.
    expect(events).toEqual([{ type: 'removed', sessionId: id }]);

    await manager.dispose();
  });

  it('two concurrent start() calls produce two distinct ids and two "added" events in order', async () => {
    // Legacy intent: process-supervisor concurrent start
    const manager = makeManager(['sess-a', 'sess-b']);
    const events: SessionManagerEvent[] = [];
    manager.subscribe((e) => events.push(e));

    const id1 = manager.start({ label: 'first', element: new SuccessElement('a'), initialCtx: { value: 0 } });
    const id2 = manager.start({ label: 'second', element: new SuccessElement('b'), initialCtx: { value: 0 } });

    expect(id1).toBe('sess-a');
    expect(id2).toBe('sess-b');
    expect(id1).not.toBe(id2);
    // Events arrive in start() call order.
    expect(events).toEqual([
      { type: 'added', sessionId: 'sess-a' },
      { type: 'added', sessionId: 'sess-b' },
    ]);

    await manager.dispose();
  });

  it('late subscribe on a terminated session: descriptor stays in registry until kill(); subscriber sees future events', async () => {
    // Legacy intent: process-supervisor late-subscribe / replay semantics
    // Sessions remain in the registry after they complete (until explicitly killed).
    // A late subscriber does NOT get historical events — it only receives
    // events fired after the subscription is registered.
    const manager = makeManager(['s1']);
    const id = manager.start({
      label: 'fast',
      element: new SuccessElement('a'),
      initialCtx: { value: 0 },
    });

    const runner = getDescriptor(manager, id).runner;
    await runner.start(); // let it complete

    // Subscribe AFTER the session has terminated.
    const seen: SessionManagerEvent[] = [];
    manager.subscribe((e) => seen.push(e));

    // The descriptor is still in the registry.
    expect(manager.get(id)).toBeDefined();
    expect(manager.get(id)?.status).toBe('completed');

    // A kill fires 'removed' which the late subscriber should receive.
    manager.kill(id);
    expect(seen).toEqual([{ type: 'removed', sessionId: id }]);

    await manager.dispose();
  });

  it('dispose() while a runner is mid-step: awaits settle and runner reaches "aborted"', async () => {
    // Legacy intent: process-supervisor dispose during active execution
    const manager = makeManager(['s1']);
    const id = manager.start({
      label: 'long',
      element: new LongRunningElement('forever'),
      initialCtx: { value: 0 },
    });

    const runner = getDescriptor(manager, id).runner;
    // Fire dispose without awaiting runner.start() first.
    const disposePromise = manager.dispose();
    // dispose() must await the runner settling.
    await disposePromise;
    // Runner was aborted during dispose.
    expect(runner.status).toBe('aborted');
  });

  it('dispose() is idempotent', async () => {
    const manager = makeManager();
    await manager.dispose();
    await expect(manager.dispose()).resolves.toBeUndefined();
  });

  it('start() after dispose() throws (registry is closed)', async () => {
    const manager = makeManager();
    await manager.dispose();
    expect(() =>
      manager.start({
        label: 'a',
        element: new SuccessElement('a'),
        initialCtx: { value: 0 },
      })
    ).toThrow(/dispose/i);
  });
});
