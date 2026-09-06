import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { releaseStdinForChild } from '@src/application/ui/shared/stdin-handoff.ts';

/**
 * The interactive handoff hangs when the parent keeps reading stdin — the terminal's reply to the
 * child's capability queries lands in our buffer instead of the child's
 * (`.claude/docs/INTERACTIVE-HANDOFF-HANG.md`). These tests pin the release sequence and the three
 * traps that make a naive version worse than nothing: `read()` on an empty buffer restarts the tty
 * handle, `removeAllListeners()` detaches consumers we do not own (that is how #327 broke
 * ScrollRegion's wheel handler), and `pause()` is a documented no-op while a `readable` listener is
 * attached — so it has to run after Node has forgotten that listener, or it never emits `'pause'`,
 * which is the event `process.stdin` stops reading the fd from.
 *
 * A real `Readable` is used rather than a hand-rolled fake so `readableLength`, `readableFlowing`,
 * `isPaused()` and the auto-resume semantics of `on('data')` behave exactly as they do on the real
 * `process.stdin`.
 */
const makeStdin = (): Readable => new Readable({ read() {} });

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('releaseStdinForChild', () => {
  it('removes only the data/readable listeners and leaves other consumers attached', async () => {
    const stdin = makeStdin();
    const onData = vi.fn();
    const onReadable = vi.fn();
    const onEnd = vi.fn();
    const onError = vi.fn();
    stdin.on('data', onData);
    stdin.on('readable', onReadable);
    stdin.on('end', onEnd);
    stdin.on('error', onError);

    await releaseStdinForChild(stdin);

    expect(stdin.listeners('data')).toEqual([]);
    expect(stdin.listeners('readable')).toEqual([]);
    expect(stdin.listeners('end')).toEqual([onEnd]);
    expect(stdin.listeners('error')).toEqual([onError]);
  });

  it('detaches by handler identity — never removeAllListeners, which is how #327 broke ScrollRegion', async () => {
    const stdin = makeStdin();
    const first = vi.fn();
    const second = vi.fn();
    const onReadable = vi.fn();
    stdin.on('data', first);
    stdin.on('data', second);
    stdin.on('readable', onReadable);
    const removeListener = vi.spyOn(stdin, 'removeListener');
    const removeAllListeners = vi.spyOn(stdin, 'removeAllListeners');

    await releaseStdinForChild(stdin);

    // The net listener count is identical either way, so assert the call shape itself: a future
    // "simplification" back to removeAllListeners must fail here rather than in production.
    expect(removeAllListeners).not.toHaveBeenCalled();
    expect(removeListener.mock.calls).toEqual([
      ['data', first],
      ['data', second],
      ['readable', onReadable],
    ]);
  });

  it('re-attaches exactly the removed listeners, in their original order', async () => {
    const stdin = makeStdin();
    const first = vi.fn();
    const second = vi.fn();
    const onReadable = vi.fn();
    stdin.on('data', first);
    stdin.on('data', second);
    stdin.on('readable', onReadable);

    const restore = await releaseStdinForChild(stdin);
    restore();

    expect(stdin.listeners('data')).toEqual([first, second]);
    expect(stdin.listeners('readable')).toEqual([onReadable]);
  });

  it('pauses the stream so the child wins the race for the terminal reply', async () => {
    const stdin = makeStdin();
    stdin.on('data', vi.fn());
    expect(stdin.isPaused()).toBe(false);

    await releaseStdinForChild(stdin);

    expect(stdin.isPaused()).toBe(true);
  });

  it('never calls read() when nothing is buffered — read() on an empty buffer re-arms the handle', async () => {
    const stdin = makeStdin();
    stdin.on('readable', vi.fn());
    // `on('readable')` schedules Node's own `read(0)` for the next tick; let it run first so the spy
    // sees only what the helper does.
    await flush();
    const read = vi.spyOn(stdin, 'read');

    await releaseStdinForChild(stdin);

    expect(read).not.toHaveBeenCalled();
  });

  it('drains bytes that were already buffered so the child does not inherit stale input', async () => {
    const stdin = makeStdin();
    stdin.push('stale keystrokes');
    expect(stdin.readableLength).toBeGreaterThan(0);

    await releaseStdinForChild(stdin);

    expect(stdin.readableLength).toBe(0);
  });

  it('resumes on restore when the stream was flowing', async () => {
    const stdin = makeStdin();
    stdin.on('data', vi.fn());
    const resume = vi.spyOn(stdin, 'resume');

    const restore = await releaseStdinForChild(stdin);
    restore();

    expect(resume).toHaveBeenCalledTimes(1);
    expect(stdin.isPaused()).toBe(false);
  });

  it('leaves a non-flowing stream paused on restore', async () => {
    const stdin = makeStdin();
    stdin.on('readable', vi.fn());
    const resume = vi.spyOn(stdin, 'resume');

    const restore = await releaseStdinForChild(stdin);
    restore();

    expect(resume).not.toHaveBeenCalled();
    expect(stdin.isPaused()).toBe(true);
  });

  it('is idempotent — a second restore does not duplicate listeners or resume again', async () => {
    const stdin = makeStdin();
    const onData = vi.fn();
    stdin.on('data', onData);
    const resume = vi.spyOn(stdin, 'resume');

    const restore = await releaseStdinForChild(stdin);
    restore();
    restore();

    expect(stdin.listeners('data')).toEqual([onData]);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('preserves a once() listener as a once listener across release/restore', async () => {
    const stdin = makeStdin();
    const onceData = vi.fn();
    stdin.once('data', onceData);

    const restore = await releaseStdinForChild(stdin);
    restore();

    stdin.push('a');
    stdin.push('b');
    await flush();

    expect(onceData).toHaveBeenCalledTimes(1);
    expect(stdin.listeners('data')).toEqual([]);
  });

  it("emits 'pause' even when a readable listener was attached — that event is what stops the fd read", async () => {
    // Node's `process.stdin` calls `readStop()` from a `'pause'` listener, and `pause()` only emits
    // while the stream is not already in the readable-listener paused state. A synchronous
    // remove-then-pause never emits here; the settle turn inside the helper is what makes it fire.
    const stdin = makeStdin();
    stdin.on('readable', vi.fn());
    const onPause = vi.fn();
    stdin.on('pause', onPause);

    await releaseStdinForChild(stdin);

    expect(onPause).toHaveBeenCalledTimes(1);
    expect(stdin.readableFlowing).toBe(false);
  });

  it("emits 'pause' exactly once when the stream was flowing through a data listener", async () => {
    const stdin = makeStdin();
    stdin.on('data', vi.fn());
    const onPause = vi.fn();
    stdin.on('pause', onPause);

    await releaseStdinForChild(stdin);

    expect(onPause).toHaveBeenCalledTimes(1);
  });
});
