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

describe('createFileLocker', () => {
  let root: string;

  beforeEach(async () => {
    const raw = await fs.mkdtemp(join(tmpdir(), 'ralphctl-locker-'));
    root = await realpath(raw);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('runs the wrapped function and removes the lock file when done', async () => {
    const locker = createFileLocker();
    const lock = lockPathIn(root, 'a.lock');
    let called = false;

    const result = await locker.withLock(lock, async () => {
      called = true;
      // While inside the critical section, the lock file exists.
      await expect(fs.readFile(String(lock), 'utf8')).resolves.toContain('"pid"');
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
    const lockPath = join(root, 'c.lock');
    // Pre-write a fresh, live lock owned by this process; takeover never fires.
    await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, timestamp: new Date().toISOString() }), {
      flag: 'wx',
    });

    const locker = createFileLocker({ maxRetries: 3, retryDelayMs: 1, sleep: async () => {} });
    const lock = lockPathIn(root, 'c.lock');
    const result = await locker.withLock(lock, async () => 'unreached');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.subCode).toBe('lock');
      expect(result.error.message).toContain('after 3 retries');
    }
  });

  it('takes over a stale lock whose timestamp exceeds staleAfterMs', async () => {
    const lockPath = join(root, 'd.lock');
    await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, timestamp: new Date(0).toISOString() }), {
      flag: 'wx',
    });

    const locker = createFileLocker({ staleAfterMs: 1, sleep: async () => {} });
    const lock = lockPathIn(root, 'd.lock');
    const result = await locker.withLock(lock, async () => 'taken-over');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('taken-over');
  });

  it('takes over a lock whose holder PID is no longer alive', async () => {
    const lockPath = join(root, 'e.lock');
    const deadPid = 999_999;
    await fs.writeFile(lockPath, JSON.stringify({ pid: deadPid, timestamp: new Date().toISOString() }), { flag: 'wx' });

    const locker = createFileLocker({
      isPidAlive: (pid) => pid !== deadPid,
      sleep: async () => {},
    });
    const lock = lockPathIn(root, 'e.lock');
    const result = await locker.withLock(lock, async () => 'reclaimed');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('reclaimed');
  });

  it('treats malformed lock-file contents as stale and takes over', async () => {
    const lockPath = join(root, 'f.lock');
    await fs.writeFile(lockPath, 'not-json', { flag: 'wx' });

    const locker = createFileLocker({ sleep: async () => {} });
    const lock = lockPathIn(root, 'f.lock');
    const result = await locker.withLock(lock, async () => 'ok');

    expect(result.ok).toBe(true);
  });

  it('serialises concurrent withLock calls on the same path', async () => {
    const locker = createFileLocker({ retryDelayMs: 2 });
    const lock = lockPathIn(root, 'g.lock');
    const order: string[] = [];

    // Start `a` first and await a microtask so its acquire() actually runs and writes the
    // lock file before `b` begins. Without the await, both promises start in the same tick
    // and the OS-level EEXIST race becomes non-deterministic across test runs.
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

  it('does NOT fire onWarning for ENOENT during release (expected stale-takeover)', async () => {
    // The wrapped function deletes our lock before the locker tries to. That's the legitimate
    // stale-takeover case: another process unlinked it first. ENOENT must be swallowed without
    // firing the warning, because operators don't need to chase a non-error.
    const warnings: Array<{ readonly kind: string; readonly path: string; readonly cause: unknown }> = [];
    const locker = createFileLocker({ onWarning: (w) => warnings.push(w) });
    const lock = lockPathIn(root, 'enoent.lock');
    const result = await locker.withLock(lock, async () => {
      await fs.unlink(String(lock)); // simulate another process taking over
    });
    expect(result.ok).toBe(true);
    expect(warnings).toHaveLength(0);
  });

  it('fires onWarning when release-unlink fails with a non-ENOENT error', async () => {
    // Replace fs.unlink with a stub that raises EACCES. Verifies the hook surfaces real
    // unlink errors (permission denied / read-only fs) so a stale `.lock` doesn't silently
    // block the next run.
    const warnings: Array<{ readonly kind: string; readonly path: string; readonly cause: unknown }> = [];
    const locker = createFileLocker({ onWarning: (w) => warnings.push(w) });
    const lock = lockPathIn(root, 'eacces.lock');

    const fsMutable = fs as { unlink: typeof fs.unlink };
    const originalUnlink = fsMutable.unlink;
    const fakeError: NodeJS.ErrnoException = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    fsMutable.unlink = (async () => {
      throw fakeError;
    }) as typeof fs.unlink;
    try {
      const result = await locker.withLock(lock, async () => 'ok' as const);
      expect(result.ok).toBe(true);
    } finally {
      fsMutable.unlink = originalUnlink;
    }

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.kind).toBe('release-unlink-failed');
    expect(warnings[0]?.cause).toBe(fakeError);
  });
});
