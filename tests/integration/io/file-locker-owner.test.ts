import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { createFileLocker, type FileLockerOptions } from '@src/integration/io/file-locker.ts';

type Warning = Parameters<NonNullable<FileLockerOptions['onWarning']>>[0];

const lockPathIn = (root: string, name: string): AbsolutePath => {
  const parsed = AbsolutePath.parse(join(root, name));
  if (!parsed.ok) throw new Error('test setup: bad path');
  return parsed.value;
};

const deadPid = async (): Promise<number> => {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((r) => child.once('exit', r));
  return child.pid!;
};

/** A lock directory left behind by another holder, with its owner file. */
const plantLock = async (
  lock: AbsolutePath,
  owner: { pid: number; host?: string; purpose?: string },
  ageMs = 0
): Promise<void> => {
  await fs.mkdir(String(lock));
  await fs.writeFile(
    join(String(lock), 'owner.json'),
    JSON.stringify({
      pid: owner.pid,
      host: owner.host ?? hostname(),
      startedAt: '2026-01-01T00:00:00.000Z',
      acquiredAt: '2026-01-01T00:00:01.000Z',
      ...(owner.purpose !== undefined ? { purpose: owner.purpose } : {}),
    })
  );
  const mtime = new Date(Date.now() - ageMs);
  await fs.utimes(String(lock), mtime, mtime);
};

describe('createFileLocker — lock owner', () => {
  let root: string;

  beforeEach(async () => {
    root = await realpath(await fs.mkdtemp(join(tmpdir(), 'ralphctl-lockowner-')));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('writes the owner file inside the held lock and still removes the lock directory on release', async () => {
    const lock = lockPathIn(root, 'repo.lock');
    const result = await createFileLocker().withLock(
      lock,
      async () => JSON.parse(await fs.readFile(join(String(lock), 'owner.json'), 'utf8')) as Record<string, unknown>,
      { purpose: 'implement' }
    );

    expect(result.ok && result.value).toMatchObject({ pid: process.pid, host: hostname(), purpose: 'implement' });
    await expect(fs.access(String(lock))).rejects.toThrow();
  });

  it('reclaims a fresh lock at once when its owner is dead on this host', async () => {
    const lock = lockPathIn(root, 'repo.lock');
    const dead = await deadPid();
    await plantLock(lock, { pid: dead, purpose: 'implement' });
    const warnings: Warning[] = [];

    const locker = createFileLocker({ maxRetries: 0, onWarning: (w) => warnings.push(w) });
    const result = await locker.withLock(lock, async () => 'reclaimed', { purpose: 'review' });

    expect(result.ok && result.value).toBe('reclaimed');
    expect(warnings).toEqual([
      expect.objectContaining({ kind: 'dead-owner-reclaimed', cause: expect.objectContaining({ pid: dead }) }),
    ]);
  });

  it('names a live holder in the contention error', async () => {
    const lock = lockPathIn(root, 'repo.lock');
    await plantLock(lock, { pid: process.ppid, purpose: 'implement' });

    const result = await createFileLocker({ maxRetries: 1, retryDelayMs: 1 }).withLock(lock, async () => 'unreached');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain(
        `another ralphctl (pid ${String(process.ppid)}) is running implement on this repo`
      );
      expect(result.error.hint).toBe('wait for that run to finish, or stop it first');
    }
  });

  it('never judges an owner on another host dead, but names the host', async () => {
    const lock = lockPathIn(root, 'repo.lock');
    await plantLock(lock, { pid: await deadPid(), host: 'other-box', purpose: 'review' });

    const result = await createFileLocker({ maxRetries: 0 }).withLock(lock, async () => 'unreached');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('on other-box) is running review on this repo');
  });

  it('still reclaims a stale lock that carries an owner file', async () => {
    const lock = lockPathIn(root, 'repo.lock');
    await plantLock(lock, { pid: process.ppid, host: 'other-box' }, 10_000);

    const result = await createFileLocker({ staleAfterMs: 2_000 }).withLock(lock, async () => 'reclaimed');

    expect(result.ok && result.value).toBe('reclaimed');
  });

  it('the owner file does not trip the heartbeat into reporting the lock compromised', async () => {
    const lock = lockPathIn(root, 'repo.lock');
    const warnings: Warning[] = [];
    const locker = createFileLocker({ staleAfterMs: 2_000, onWarning: (w) => warnings.push(w) });

    const result = await locker.withLock(lock, () => new Promise((r) => setTimeout(() => r('held'), 2_600)), {
      purpose: 'implement',
    });

    expect(result.ok && result.value).toBe('held');
    expect(warnings).toEqual([]);
  }, 8_000);
});
