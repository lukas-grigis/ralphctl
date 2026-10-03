import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { Slug } from '@src/domain/value/slug.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { LockHolder } from '@src/business/runs/find-live-sprint-owner.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import { withRepoLock } from '@src/application/flows/_shared/with-repo-lock.ts';
import { createFileLocker, DEFAULT_STALE_AFTER_MS } from '@src/integration/io/file-locker.ts';
import { repoLockFile } from '@src/integration/io/lock-paths.ts';
import { createSprintLockReader } from '@src/integration/io/sprint-lock-reader.ts';
import { sprintDir } from '@src/integration/persistence/storage.ts';
import { absolutePath } from '@tests/fixtures/domain.ts';

const SPRINT = { id: 'sprint-7' as SprintId, slug: 'lock-route' as Slug };

const silentBus: EventBus = { publish: () => undefined, subscribe: () => () => undefined };

let root: string;
let dataRoot: string;
let locksRoot: string;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'ralphctl-sprint-lock-')));
  dataRoot = join(root, 'data');
  locksRoot = join(root, 'locks');
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const reader = () => createSprintLockReader({ dataRoot: absolutePath(dataRoot), locksRoot: absolutePath(locksRoot) });

/** The key both launchers hand implement (`opts.sprintDir` → `plan.lockKey`) and review (`opts.sprintDir`). */
const launcherSprintDir = () => absolutePath(sprintDir(absolutePath(dataRoot), SPRINT.id, SPRINT.slug));

const plantLock = async (owner: Record<string, unknown> | undefined, ageMs = 0): Promise<void> => {
  const lock = repoLockFile(absolutePath(locksRoot), launcherSprintDir());
  if (!lock.ok) throw new Error('test setup: bad lock path');
  await fs.mkdir(String(lock.value), { recursive: true });
  if (owner !== undefined) await fs.writeFile(join(String(lock.value), 'owner.json'), JSON.stringify(owner));
  const mtime = new Date(Date.now() - ageMs);
  await fs.utimes(String(lock.value), mtime, mtime);
};

const livePid = (): number => process.ppid;

const deadPid = async (): Promise<number> => {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((resolve) => child.once('exit', resolve));
  return child.pid!;
};

describe('createSprintLockReader', () => {
  it('sees the lock a flow takes through withRepoLock on the launcher sprint dir, and nothing once released', async () => {
    let seen: LockHolder | undefined;
    const inner = leaf<object, object, object>('probe-lock', {
      input: (ctx) => ctx,
      useCase: {
        execute: async (input) => {
          seen = await reader().holderOf(SPRINT);
          return Result.ok(input);
        },
      },
      output: (ctx) => ctx,
    });
    const locked = withRepoLock(
      {
        fileLocker: createFileLocker(),
        locksRoot: absolutePath(locksRoot),
        worktreePath: launcherSprintDir(),
        eventBus: silentBus,
        purpose: 'review',
      },
      inner
    );

    const result = await locked.execute({});

    expect(result.ok).toBe(true);
    expect(seen?.pid).toBe(process.pid);
    if (process.platform !== 'win32') expect(seen?.identity?.startedAt).toMatch(/\d{2}:\d{2}:\d{2} \d{4}$/);
    expect(await reader().holderOf(SPRINT)).toBeUndefined();
  });

  it('reports a fresh lock owner with its identity', async () => {
    const identity = { startedAt: 'Fri Oct 2 07:40:35 2026', command: 'node' };
    await plantLock({ pid: livePid(), host: hostname(), startedAt: 'x', acquiredAt: 'y', identity });
    expect(await reader().holderOf(SPRINT)).toEqual({ pid: livePid(), host: hostname(), identity });
  });

  it('ignores a lock whose heartbeat is older than the stale window, even when the pid is alive', async () => {
    await plantLock(
      { pid: livePid(), host: hostname(), startedAt: 'x', acquiredAt: 'y' },
      DEFAULT_STALE_AFTER_MS + 5_000
    );
    expect(await reader().holderOf(SPRINT)).toBeUndefined();
  });

  it('ignores a lock without an owner file, and drops a malformed identity', async () => {
    await plantLock(undefined);
    expect(await reader().holderOf(SPRINT)).toBeUndefined();

    const pid = await deadPid();
    await plantLock({ pid, host: hostname(), startedAt: 'x', acquiredAt: 'y', identity: { startedAt: 7 } });
    expect(await reader().holderOf(SPRINT)).toEqual({ pid, host: hostname() });
  });
});
