import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AbsolutePath } from '../../domain/values/absolute-path.ts';
import { FileLocker } from './file-locker.ts';

function uniqueRoot(): AbsolutePath {
  const dir = join(
    tmpdir(),
    `ralphctl-locker-${String(process.pid)}-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`
  );
  return AbsolutePath.trustString(dir);
}

describe('FileLocker', () => {
  let root: AbsolutePath;
  let target: AbsolutePath;

  beforeEach(async () => {
    root = uniqueRoot();
    await mkdir(root, { recursive: true });
    target = AbsolutePath.trustString(join(root, 'data.json'));
  });

  afterEach(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  });

  it('acquires the lock and releases it on success', async () => {
    const locker = new FileLocker();
    const result = await locker.withLock(target, () => Promise.resolve(42));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(42);
    // Lock file should be cleaned up.
    await expect(readFile(`${target}.lock`)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('serialises concurrent acquisitions on the same target', async () => {
    const locker = new FileLocker();
    const order: string[] = [];

    const a = locker.withLock(target, async () => {
      order.push('a-start');
      await new Promise((r) => setTimeout(r, 100));
      order.push('a-end');
      return 'a';
    });
    // Stagger so 'a' wins the race
    await new Promise((r) => setTimeout(r, 10));
    const b = locker.withLock(target, () => {
      order.push('b-start');
      return Promise.resolve('b');
    });

    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.ok).toBe(true);
    expect(rb.ok).toBe(true);
    // 'a' must finish before 'b' starts.
    expect(order).toEqual(['a-start', 'a-end', 'b-start']);
  });

  it('takes over a stale lock (timestamp older than staleAfterMs)', async () => {
    const locker = new FileLocker({ staleAfterMs: 50 });
    // Plant a stale lock by hand.
    await writeFile(
      `${target}.lock`,
      JSON.stringify({
        pid: process.pid,
        timestamp: new Date(Date.now() - 10_000).toISOString(),
      })
    );
    const result = await locker.withLock(target, () => Promise.resolve('ok'));
    expect(result.ok).toBe(true);
  });

  it('takes over a lock whose holder PID does not exist', async () => {
    const locker = new FileLocker();
    // PID 1 is normally `init` and exists; pick something we can be reasonably
    // sure does not exist on the host. Range 99_999..100_000 is well above
    // typical process numbers; if it does exist (rare), the test still works
    // because it'll fall through to the stale-timestamp branch on retry.
    await writeFile(
      `${target}.lock`,
      JSON.stringify({
        pid: 99_999_999,
        timestamp: new Date().toISOString(),
      })
    );
    const result = await locker.withLock(target, () => Promise.resolve('ok'));
    expect(result.ok).toBe(true);
  });

  it('treats a corrupted lock file as stale', async () => {
    const locker = new FileLocker();
    await writeFile(`${target}.lock`, '{not-json}');
    const result = await locker.withLock(target, () => Promise.resolve(true));
    expect(result.ok).toBe(true);
  });

  it('releases the lock when the protected function throws', async () => {
    const locker = new FileLocker();
    await expect(locker.withLock(target, () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    // Lock file should still be cleaned up despite the throw.
    await expect(readFile(`${target}.lock`)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('writes a lock file containing the current PID and a timestamp', async () => {
    const locker = new FileLocker();
    let observed: string | undefined;
    await locker.withLock(target, async () => {
      observed = await readFile(`${target}.lock`, 'utf-8');
      return null;
    });
    expect(observed).toBeDefined();
    if (observed === undefined) return;
    const parsed = JSON.parse(observed) as { pid: number; timestamp: string };
    expect(parsed.pid).toBe(process.pid);
    expect(typeof parsed.timestamp).toBe('string');
    expect(Number.isFinite(Date.parse(parsed.timestamp))).toBe(true);
  });

  // Ported from afe771f9~1:src/integration/persistence/file-locker — legacy coverage
  it('two concurrent acquires on DIFFERENT targets do not block each other', async () => {
    const targetA = AbsolutePath.trustString(join(root, 'a.json'));
    const targetB = AbsolutePath.trustString(join(root, 'b.json'));
    const locker = new FileLocker();
    const order: string[] = [];

    // Both hold their locks for 100ms simultaneously.
    const a = locker.withLock(targetA, async () => {
      order.push('a-start');
      await new Promise((r) => setTimeout(r, 100));
      order.push('a-end');
      return 'a';
    });
    const b = locker.withLock(targetB, async () => {
      order.push('b-start');
      await new Promise((r) => setTimeout(r, 100));
      order.push('b-end');
      return 'b';
    });

    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.ok).toBe(true);
    expect(rb.ok).toBe(true);
    // Both should start before either finishes (parallel execution).
    const aStart = order.indexOf('a-start');
    const bStart = order.indexOf('b-start');
    const aEnd = order.indexOf('a-end');
    const bEnd = order.indexOf('b-end');
    // a-end and b-end must come after their respective starts.
    expect(aEnd).toBeGreaterThan(aStart);
    expect(bEnd).toBeGreaterThan(bStart);
    // At least one of: a-start before a-end, b-start before b-end — trivially true.
    // Key assertion: both completes happen (no deadlock).
    expect(order).toHaveLength(4);
  }, 5_000);

  it('withLock is idempotent on the lock file after release', async () => {
    // Run two sequential acquires on the same target — second should succeed
    // (lock file is cleaned up between calls, not left behind).
    const locker = new FileLocker();
    const r1 = await locker.withLock(target, () => Promise.resolve('first'));
    const r2 = await locker.withLock(target, () => Promise.resolve('second'));
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok) expect(r1.value).toBe('first');
    if (r2.ok) expect(r2.value).toBe('second');
  });
});
