import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';
import { ensureStorageRoots, storagePathsFromRoot } from '@src/application/bootstrap/storage-paths.ts';
import { wire } from '@src/application/bootstrap/wire.ts';
import { createFsLiveRunStore, liveRunsDir } from '@src/integration/persistence/live-run/fs-live-run-store.ts';
import { createProcessLiveness } from '@src/integration/io/process-liveness.ts';
import type { LiveRunRecord } from '@src/business/runs/live-run.ts';
import { absolutePath } from '@tests/fixtures/domain.ts';
import { isAlive, killQuietly, waitForDeath, writeStubCli } from '@tests/helpers/process-tree.ts';
import { DEFAULT_REAPER_GRACE_MS } from '@src/integration/io/orphan-reaper.ts';

const posix = process.platform !== 'win32';
const REPO_ROOT = resolve(import.meta.dirname, '../../../..');
const HARNESS = join(REPO_ROOT, 'tests/fixtures/process-lifecycle-harness.ts');
const leftovers: number[] = [];
const leftoverGroups: number[] = [];
const harnesses: ChildProcess[] = [];

afterEach(() => {
  for (const h of harnesses.splice(0)) h.kill('SIGKILL');
  killQuietly(leftovers.splice(0));
  killQuietly(leftoverGroups.splice(0).map((pgid) => -pgid));
});

const readRecord = async (appRoot: string, runId: string): Promise<LiveRunRecord | undefined> => {
  try {
    return JSON.parse(
      await fs.readFile(join(liveRunsDir(absolutePath(join(appRoot, 'state'))), `${runId}.json`), 'utf8')
    ) as LiveRunRecord;
  } catch {
    return undefined;
  }
};

const waitFor = async <T>(probe: () => Promise<T | undefined>, timeoutMs: number): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('condition never held');
};

/** A dead pid: spawn something trivial and wait for it to exit. */
const deadPid = async (): Promise<number> => {
  const child = nodeSpawn('true', [], { stdio: 'ignore' });
  await new Promise((r) => child.once('exit', r));
  return child.pid!;
};

const wireAt = async (appRoot: string) => {
  const paths = storagePathsFromRoot(absolutePath(appRoot));
  if (!paths.ok) throw paths.error;
  await ensureStorageRoots(paths.value);
  return wire({ storage: paths.value, settings: DEFAULT_SETTINGS });
};

describe.skipIf(!posix)('orphan reaper', () => {
  it('kills the AI CLI and its tool subprocess when the harness is SIGKILLed, and leaves an interrupted-run record', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'ralphctl-reaper-'));
    const appRoot = join(root, 'app');
    const cwd = join(root, 'repo');
    await fs.mkdir(cwd, { recursive: true });
    const stub = await writeStubCli(join(root, 'bin'));

    const harness = nodeSpawn(process.execPath, ['--import', 'tsx', HARNESS, appRoot, cwd], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'ignore', 'inherit'],
      env: { ...process.env, PATH: `${stub.dir}:${process.env['PATH'] ?? ''}`, NODE_OPTIONS: '' },
    });
    harnesses.push(harness);
    const { child, grandchild } = await stub.pids(20_000);
    leftovers.push(child, grandchild);
    leftoverGroups.push(child);

    // The run record lists the spawn (with its group) before the harness dies.
    const record = await waitFor(async () => {
      const r = await readRecord(appRoot, 'r-reaper-test');
      return r?.spawns.some((s) => s.pgid === child) === true ? r : undefined;
    }, 10_000);
    expect(record).toMatchObject({ flowId: 'implement', sprintId: 'sprint-1', owner: { pid: harness.pid } });
    expect(record.spawns[0]).toMatchObject({ pid: child, pgid: child, provider: 'claude-code', round: 3 });

    harness.kill('SIGKILL');
    await new Promise((r) => harness.once('exit', r));

    expect(await waitForDeath([child, grandchild], DEFAULT_REAPER_GRACE_MS + 2_000)).toBe(true);

    // The record outlived its owner: the run reads as interrupted, and the boot-time reap stamps it.
    const deps = await wireAt(appRoot);
    const detected = await deps.detectInterruptedRuns.execute();
    expect(detected.ok && detected.value.map((r) => r.record.runId)).toEqual(['r-reaper-test']);
    const reaped = await deps.reapInterruptedRuns.execute();
    expect(reaped.ok && reaped.value).toEqual({ runIds: ['r-reaper-test'], reapedGroups: [] });
    expect((await readRecord(appRoot, 'r-reaper-test'))?.reapedAt).toBeDefined();
  }, 40_000);

  it('the boot-time reap kills a group an interrupted run left alive, and spares a recycled pid', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'ralphctl-bootreap-'));
    const appRoot = join(root, 'app');
    const orphan = nodeSpawn('sh', ['-c', 'sleep 300 & wait'], { detached: true, stdio: 'ignore' });
    const recycled = nodeSpawn('sh', ['-c', 'sleep 300 & wait'], { detached: true, stdio: 'ignore' });
    leftoverGroups.push(orphan.pid!, recycled.pid!);
    const liveness = createProcessLiveness();
    const identity = await liveness.identify(orphan.pid!);
    expect(identity).toBeDefined();

    const owner = { pid: await deadPid(), host: liveness.host, startedAt: '2026-01-01T00:00:00.000Z' };
    const spawnOf = (pid: number, id: typeof identity) => ({
      pid,
      pgid: pid,
      provider: 'claude-code',
      command: 'claude',
      cwd: root,
      signalsFile: join(root, 'signals.json'),
      startedAt: '2026-01-01T00:00:00.000Z',
      ...(id !== undefined ? { identity: id } : {}),
    });
    const store = createFsLiveRunStore({ stateRoot: absolutePath(join(appRoot, 'state')) });
    await store.save({
      version: 1,
      runId: 'r-crashed',
      flowId: 'implement',
      owner,
      startedAt: owner.startedAt,
      updatedAt: owner.startedAt,
      spawns: [
        spawnOf(orphan.pid!, identity),
        // Same pid shape, but the process there now is not the one recorded.
        spawnOf(recycled.pid!, { startedAt: 'Thu Jan 1 00:00:00 1970', command: 'claude' }),
      ],
    });

    const deps = await wireAt(appRoot);
    const reaped = await deps.reapInterruptedRuns.execute();

    expect(reaped.ok && reaped.value.reapedGroups).toEqual([orphan.pid]);
    expect(await waitForDeath([orphan.pid!], 3_000)).toBe(true);
    expect(isAlive(recycled.pid!)).toBe(true);
  }, 20_000);
});
