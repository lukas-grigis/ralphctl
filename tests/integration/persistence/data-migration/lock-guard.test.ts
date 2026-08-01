/**
 * Unit tests for the migration lock guard. The apply step refuses to run while a flow lock is held —
 * a rename must never race a running implement flow that has a sprint dir path baked into its ctx.
 */

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { absolutePath } from '@tests/fixtures/domain.ts';
import { anyLockHeld } from '@src/integration/persistence/data-migration/lock-guard.ts';
import { DEFAULT_STALE_AFTER_MS } from '@src/integration/io/file-locker.ts';

let stateRoot: string;

beforeEach(async () => {
  stateRoot = await fs.mkdtemp(join(tmpdir(), 'ralph-locks-'));
});

afterEach(async () => {
  await fs.rm(stateRoot, { recursive: true, force: true });
});

const locksDir = () => join(stateRoot, 'locks');

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
