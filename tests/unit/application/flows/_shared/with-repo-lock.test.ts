import { describe, expect, it } from 'vitest';

import { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { AppEvent } from '@src/business/observability/events.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import type { FileLocker } from '@src/integration/io/file-locker.ts';
import { withRepoLock } from '@src/application/flows/_shared/with-repo-lock.ts';

import { absolutePath } from '@tests/fixtures/domain.ts';

interface Ctx {
  readonly value: string;
}

const spyEventBus = (): { readonly bus: EventBus; readonly events: AppEvent[] } => {
  const events: AppEvent[] = [];
  return {
    events,
    bus: {
      publish(event) {
        events.push(event);
      },
      subscribe() {
        return () => {};
      },
    },
  };
};

/** A trivial ok leaf, so `withRepoLock`'s inner-passthrough plumbing is real chain code, not a stub. */
const okInner = (): Element<Ctx> =>
  leaf<Ctx, Ctx, Ctx>('inner-ok', {
    input: (ctx) => ctx,
    useCase: { execute: async (input) => Result.ok({ ...input, value: 'ran' }) },
    output: (_ctx, out) => out,
  });

/** A leaf that records whether the signal it observed was aborted at call time. */
const signalObservingInner = (observed: { aborted?: boolean }): Element<Ctx> =>
  leaf<Ctx, Ctx, Ctx>('inner-observer', {
    input: (ctx) => ctx,
    useCase: {
      execute: async (input, signal) => {
        observed.aborted = signal?.aborted ?? false;
        return Result.ok(input);
      },
    },
    output: (_ctx, out) => out,
  });

const opts = (fileLocker: FileLocker, eventBus: EventBus): Parameters<typeof withRepoLock>[0] => ({
  fileLocker,
  locksRoot: absolutePath('/locks'),
  worktreePath: absolutePath('/repos/main'),
  eventBus,
});

/**
 * A `FileLocker` stub that always "acquires" and hands `fn` the given signal. Declares its own
 * generic `T` on the method (shadowing the interface's) and casts the result — without this,
 * `Result.ok(await fn(signal))` infers as `Ok<Awaited<T>>`, which tsc rejects against the
 * interface's `Promise<Result<T, StorageError>>` for the unresolved generic `T`.
 */
const okLocker = (signal: AbortSignal): FileLocker => ({
  withLock: async <T>(_path: AbsolutePath, fn: (signal: AbortSignal) => Promise<T>) =>
    Result.ok(await fn(signal)) as Result<T, StorageError>,
});

describe('withRepoLock', () => {
  it('exposes the wrapped inner element via `children` for TUI plan-walking (flattenLeaves)', () => {
    const inner = okInner();
    const fileLocker = okLocker(new AbortController().signal);
    const { bus } = spyEventBus();

    const wrapped = withRepoLock(opts(fileLocker, bus), inner);

    expect(wrapped.name).toBe('with-repo-lock(inner-ok)');
    expect(wrapped.children).toStrictEqual([inner]);
  });

  it('acquires the lock, runs the inner chain, and bubbles its ctx/trace through on success', async () => {
    const inner = okInner();
    let capturedPath: AbsolutePath | undefined;
    const fileLocker: FileLocker = {
      withLock: async <T>(path: AbsolutePath, fn: (signal: AbortSignal) => Promise<T>) => {
        capturedPath = path;
        return Result.ok(await fn(new AbortController().signal)) as Result<T, StorageError>;
      },
    };
    const { bus, events } = spyEventBus();

    const result = await withRepoLock(opts(fileLocker, bus), inner).execute({ value: 'start' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.ctx).toStrictEqual({ value: 'ran' });
      expect(result.value.trace.map((e) => e.elementName)).toStrictEqual(['inner-ok']);
    }
    // Lock key is a deterministic hash of the worktree path — the locker sees a real path, not the ctx.
    expect(capturedPath).toBeDefined();
    expect(String(capturedPath)).toMatch(/^\/locks\/repo-[0-9a-f]{16}\.lock$/);
    // Success never publishes a banner.
    expect(events).toStrictEqual([]);
  });

  it('releases the lock even when the inner chain fails — bubbles the inner failure unwrapped, no banner', async () => {
    const failingInner: Element<Ctx> = leaf<Ctx, Ctx, Ctx>('inner-failing', {
      input: (ctx) => ctx,
      useCase: {
        execute: async () => Result.error(new StorageError({ subCode: 'io', message: 'boom' })),
      },
      output: (_ctx, out) => out,
    });
    const fileLocker = okLocker(new AbortController().signal);
    const { bus, events } = spyEventBus();

    const result = await withRepoLock(opts(fileLocker, bus), failingInner).execute({ value: 'start' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error).toBeInstanceOf(StorageError);
      expect(result.error.trace.map((e) => `${e.elementName}:${e.status}`)).toStrictEqual(['inner-failing:failed']);
    }
    // The inner's own failure is bubbled unwrapped — only a genuine ACQUIRE failure publishes the banner.
    expect(events).toStrictEqual([]);
  });

  it('when lock acquisition itself fails, publishes a warn banner and fails with the locker StorageError', async () => {
    const inner = okInner();
    const acquireError = new StorageError({ subCode: 'lock', message: 'failed to acquire lock after 100 retries' });
    const fileLocker: FileLocker = { withLock: async () => Result.error(acquireError) };
    const { bus, events } = spyEventBus();

    const result = await withRepoLock(opts(fileLocker, bus), inner).execute({ value: 'start' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error).toBe(acquireError);
      expect(result.error.trace).toStrictEqual([
        {
          elementName: 'with-repo-lock(inner-ok)',
          status: 'failed',
          durationMs: expect.any(Number),
          error: acquireError,
        },
      ]);
    }
    expect(events).toHaveLength(1);
    const banner = events[0];
    expect(banner?.type).toBe('banner-show');
    if (banner?.type === 'banner-show') {
      expect(banner.tier).toBe('warn');
      expect(banner.id).toMatch(/^lock-\/locks\/repo-[0-9a-f]{16}\.lock$/);
      expect(banner.cause).toMatch(/^\/locks\/repo-[0-9a-f]{16}\.lock$/);
    }
    // The inner element never ran — it never gets to record its own trace entry.
    expect(inner.name).toBe('inner-ok'); // sanity: same inner instance, untouched
  });

  it('merges a compromised lock signal into the inner chain so it tears down as an AbortError', async () => {
    const observed: { aborted?: boolean } = {};
    const inner = signalObservingInner(observed);
    // Simulate FileLocker handing back an ALREADY-fired lock-compromised signal — the inner chain
    // must observe it as aborted via `combineAbortSignals`, exactly as a live lock takeover would.
    const compromised = new AbortController();
    compromised.abort(new Error('lock compromised'));
    const fileLocker = okLocker(compromised.signal);
    const { bus, events } = spyEventBus();

    const result = await withRepoLock(opts(fileLocker, bus), inner).execute({ value: 'start' });

    // The inner leaf's own `checkAborted` guard fires before its use case runs, so the use case body
    // (which would have recorded `observed.aborted = false`) never executes.
    expect(observed.aborted).toBeUndefined();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.trace.map((e) => `${e.elementName}:${e.status}`)).toStrictEqual(['inner-observer:aborted']);
    }
    // A compromised-mid-run lock is not an acquire failure — no banner.
    expect(events).toStrictEqual([]);
  });

  it('merges the host abort signal with the lock signal — a host-level abort tears the inner chain down too', async () => {
    const observed: { aborted?: boolean } = {};
    const inner = signalObservingInner(observed);
    const fileLocker = okLocker(new AbortController().signal);
    const { bus } = spyEventBus();
    const host = new AbortController();
    host.abort(new Error('user cancelled'));

    const result = await withRepoLock(opts(fileLocker, bus), inner).execute({ value: 'start' }, host.signal);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.trace.map((e) => `${e.elementName}:${e.status}`)).toStrictEqual(['inner-observer:aborted']);
    }
  });

  it('forwards progressive onTrace calls from the inner chain untouched', async () => {
    const inner = okInner();
    const fileLocker = okLocker(new AbortController().signal);
    const { bus } = spyEventBus();
    const traced: string[] = [];

    await withRepoLock(opts(fileLocker, bus), inner).execute({ value: 'start' }, undefined, (entry) => {
      traced.push(entry.elementName);
    });

    expect(traced).toStrictEqual(['inner-ok']);
  });
});
