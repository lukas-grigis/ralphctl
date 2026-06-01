import { promises as fs } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { createFileLocker } from '@src/integration/io/file-locker.ts';

const lockPathIn = (root: string, name: string): AbsolutePath => {
  const parsed = AbsolutePath.parse(join(root, name));
  if (!parsed.ok) throw new Error('test setup: bad path');
  return parsed.value;
};

/** Poll `predicate` until true or `timeoutMs` elapses. Returns silently either way. */
const waitFor = async (predicate: () => boolean, timeoutMs: number): Promise<void> => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) return;
    await new Promise((r) => setTimeout(r, 25));
  }
};

// The locker is backed by `proper-lockfile`: the on-disk lock is a DIRECTORY at the lock path
// (atomic `mkdir`), kept fresh by a background heartbeat. A live holder is never falsely stolen;
// a holder that stops heartbeating (crash) goes stale and is reclaimed. These tests exercise that
// model through the public `withLock` API only — there are no `now`/`pid`/`sleep` seams.
describe('createFileLocker', () => {
  let root: string;

  beforeEach(async () => {
    const raw = await fs.mkdtemp(join(tmpdir(), 'ralphctl-locker-'));
    root = await realpath(raw);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('runs the wrapped function and removes the lock directory when done', async () => {
    const locker = createFileLocker();
    const lock = lockPathIn(root, 'a.lock');
    let called = false;

    const result = await locker.withLock(lock, async () => {
      called = true;
      // While inside the critical section, the lock directory exists.
      const stat = await fs.stat(String(lock));
      expect(stat.isDirectory()).toBe(true);
      return 42;
    });

    expect(called).toBe(true);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(42);
    await expect(fs.access(String(lock))).rejects.toThrow();
  });

  it('clears the lock even when the wrapped function throws', async () => {
    const locker = createFileLocker();
    const lock = lockPathIn(root, 'b.lock');

    await expect(
      locker.withLock(lock, async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    await expect(fs.access(String(lock))).rejects.toThrow();
  });

  it('rejects with StorageError(subCode=lock) when contended past the retry budget', async () => {
    // Pre-create a FRESH lock directory (mtime ≈ now): not stale, so takeover never fires and the
    // contender exhausts its retry budget.
    const held = lockPathIn(root, 'c.lock');
    await fs.mkdir(String(held));

    const locker = createFileLocker({ maxRetries: 2, retryDelayMs: 1 });
    const result = await locker.withLock(held, async () => 'unreached');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.subCode).toBe('lock');
      expect(result.error.message).toContain('after 2 retries');
    }
  });

  it('reclaims a stale lock whose holder stopped heartbeating (crash)', async () => {
    // A crashed holder leaves a lock directory whose mtime no longer advances. Simulate it: an
    // existing lock dir backdated well past the stale window is taken over on the next acquire.
    const stale = lockPathIn(root, 'd.lock');
    await fs.mkdir(String(stale));
    const old = new Date(Date.now() - 10_000);
    await fs.utimes(String(stale), old, old);

    const locker = createFileLocker({ staleAfterMs: 2_000 });
    const result = await locker.withLock(stale, async () => 'reclaimed');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('reclaimed');
    await expect(fs.access(String(stale))).rejects.toThrow();
  });

  it('serialises concurrent withLock calls on the same path', async () => {
    const locker = createFileLocker({ retryDelayMs: 2 });
    const lock = lockPathIn(root, 'g.lock');
    const order: string[] = [];

    // Start `a` first and yield a few ms so its acquire() materialises the lock directory before
    // `b` begins — then `b` must wait (retry) until `a` releases.
    const a = locker.withLock(lock, async () => {
      order.push('a-start');
      await new Promise((r) => setTimeout(r, 20));
      order.push('a-end');
    });
    await new Promise((r) => setTimeout(r, 5));
    const b = locker.withLock(lock, async () => {
      order.push('b-start');
      order.push('b-end');
    });

    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.ok && rb.ok).toBe(true);
    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
  });

  it('does not fire onWarning on a clean acquire/release cycle', async () => {
    const warnings: Array<{ readonly kind: string }> = [];
    const locker = createFileLocker({ onWarning: (w) => warnings.push(w) });
    const lock = lockPathIn(root, 'clean.lock');

    const result = await locker.withLock(lock, async () => 'ok');

    expect(result.ok).toBe(true);
    expect(warnings).toHaveLength(0);
  });

  it('aborts the wrapped function signal and warns when the held lock is compromised', async () => {
    // Remove the lock directory out from under the holder. The heartbeat's next mtime refresh
    // fails, so proper-lockfile flags the lock compromised. The library default for that is to
    // THROW (which would crash the process) — our adapter instead aborts the signal handed to `fn`
    // AND surfaces a warning. A small staleAfterMs makes the heartbeat tick ~1s so the test does
    // not have to wait the 30s default.
    const warnings: Array<{ readonly kind: string; readonly cause: unknown }> = [];
    const locker = createFileLocker({ staleAfterMs: 2_000, onWarning: (w) => warnings.push(w) });
    const lock = lockPathIn(root, 'compromised.lock');

    let sawAbort = false;
    const result = await locker.withLock(lock, async (signal) => {
      await fs.rm(String(lock), { recursive: true, force: true });
      await waitFor(() => signal.aborted, 5_000);
      sawAbort = signal.aborted;
      return 'observed';
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('observed');
    expect(sawAbort).toBe(true);
    expect(warnings.some((w) => w.kind === 'lock-compromised')).toBe(true);
  }, 8_000);
});
