/**
 * The flow-lock guard: migration apply, cascade project removal and housekeeping purges refuse while a
 * lock is held, so none of them races a running flow that has a sprint dir path baked into its ctx.
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { absolutePath } from '@tests/fixtures/domain.ts';
import { anyLockHeld, createLockRunActivityProbe } from '@src/integration/io/lock-guard.ts';
import { DEFAULT_STALE_AFTER_MS } from '@src/integration/io/file-locker.ts';

let stateRoot: string;

beforeEach(async () => {
  stateRoot = await fs.mkdtemp(join(tmpdir(), 'ralph-locks-'));
});

afterEach(async () => {
  await fs.rm(stateRoot, { recursive: true, force: true });
});

const locksDir = () => join(stateRoot, 'locks');

const deadPid = async (): Promise<number> => {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((resolve) => child.once('exit', resolve));
  return child.pid!;
};

/** A fresh lock dir whose `owner.json` names `pid` on `host`. */
const plantOwnedLock = async (name: string, pid: number, host = hostname()): Promise<void> => {
  const lock = join(locksDir(), name);
  await fs.mkdir(lock, { recursive: true });
  await fs.writeFile(join(lock, 'owner.json'), JSON.stringify({ pid, host, startedAt: 'x', acquiredAt: 'y' }));
};

describe('anyLockHeld', () => {
  it('absent locks dir → not held', async () => {
    expect(await anyLockHeld(absolutePath(stateRoot))).toBe(false);
  });

  it('empty locks dir → not held', async () => {
    await fs.mkdir(locksDir(), { recursive: true });
    expect(await anyLockHeld(absolutePath(stateRoot))).toBe(false);
  });

  it('a freshly-created .lock dir → held', async () => {
    await fs.mkdir(join(locksDir(), 'repo-abc123.lock'), { recursive: true });
    expect(await anyLockHeld(absolutePath(stateRoot))).toBe(true);
  });

  it('a stale .lock dir (old mtime) → NOT held', async () => {
    const lock = join(locksDir(), 'repo-stale.lock');
    await fs.mkdir(lock, { recursive: true });
    const old = new Date(Date.now() - 5 * 60_000); // 5 minutes ago — well past the held window
    await fs.utimes(lock, old, old);
    expect(await anyLockHeld(absolutePath(stateRoot))).toBe(false);
  });

  it('ignores non-.lock entries', async () => {
    await fs.mkdir(locksDir(), { recursive: true });
    await fs.writeFile(join(locksDir(), 'README.txt'), 'x', 'utf8');
    expect(await anyLockHeld(absolutePath(stateRoot))).toBe(false);
  });

  // Pins the held-window to `file-locker.ts`'s actual DEFAULT_STALE_AFTER_MS (not a duplicated
  // literal) so the two constants can never silently drift apart again — see the shared
  // source-of-truth note on DEFAULT_STALE_AFTER_MS.
  it('treats a lock as held right up to file-locker.ts DEFAULT_STALE_AFTER_MS, stale just past it', async () => {
    const justWithin = join(locksDir(), 'repo-just-within.lock');
    await fs.mkdir(justWithin, { recursive: true });
    const withinMtime = new Date(Date.now() - (DEFAULT_STALE_AFTER_MS - 1_000));
    await fs.utimes(justWithin, withinMtime, withinMtime);
    expect(await anyLockHeld(absolutePath(stateRoot))).toBe(true);

    await fs.rm(justWithin, { recursive: true, force: true });

    const justPast = join(locksDir(), 'repo-just-past.lock');
    await fs.mkdir(justPast, { recursive: true });
    const pastMtime = new Date(Date.now() - (DEFAULT_STALE_AFTER_MS + 1_000));
    await fs.utimes(justPast, pastMtime, pastMtime);
    expect(await anyLockHeld(absolutePath(stateRoot))).toBe(false);
  });
});

describe('anyLockHeld — owner file', () => {
  it('a fresh lock whose owner pid is dead on this machine → NOT held', async () => {
    await plantOwnedLock('repo-crashed.lock', await deadPid());
    expect(await anyLockHeld(absolutePath(stateRoot))).toBe(false);
  });

  it('a fresh lock whose owner is alive, or dead on another machine → held', async () => {
    await plantOwnedLock('repo-alive.lock', process.ppid);
    expect(await anyLockHeld(absolutePath(stateRoot))).toBe(true);

    await fs.rm(join(locksDir(), 'repo-alive.lock'), { recursive: true, force: true });
    await plantOwnedLock('repo-elsewhere.lock', await deadPid(), 'some-other-host');
    expect(await anyLockHeld(absolutePath(stateRoot))).toBe(true);
  });
});

describe('createLockRunActivityProbe', () => {
  it('reports a run active while a fresh lock is held', async () => {
    await fs.mkdir(join(locksDir(), 'repo-live.lock'), { recursive: true });
    expect(await createLockRunActivityProbe(absolutePath(stateRoot)).anyRunActive()).toBe(true);
  });

  it('ignores a stale crash-leftover lock', async () => {
    const lock = join(locksDir(), 'repo-crashed.lock');
    await fs.mkdir(lock, { recursive: true });
    const old = new Date(Date.now() - (DEFAULT_STALE_AFTER_MS + 60_000));
    await fs.utimes(lock, old, old);
    expect(await createLockRunActivityProbe(absolutePath(stateRoot)).anyRunActive()).toBe(false);
  });
});
