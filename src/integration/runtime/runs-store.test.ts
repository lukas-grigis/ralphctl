import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExecutionAlreadyRunningError } from '@src/domain/errors.ts';
import {
  claimSprintLock,
  getRunStatePath,
  getRunsDir,
  getSprintLockPath,
  isProcessAlive,
  listRuns,
  pruneStale,
  readRun,
  recordRun,
  releaseSprintLock,
  type RunState,
  updateStatus,
} from './runs-store.ts';

let runsRoot: string;

beforeEach(async () => {
  runsRoot = await mkdtemp(join(tmpdir(), 'ralphctl-runs-store-'));
  process.env['RALPHCTL_ROOT'] = runsRoot;
});

afterEach(async () => {
  delete process.env['RALPHCTL_ROOT'];
  await rm(runsRoot, { recursive: true, force: true });
});

function makeState(overrides: Partial<RunState> = {}): RunState {
  return {
    executionId: 'exec-1',
    pid: process.pid,
    sprintId: 'sprint-a',
    projectName: 'alpha',
    status: 'running',
    startedAt: '2026-04-29T00:00:00.000Z',
    ...overrides,
  };
}

describe('runs-store — file lifecycle', () => {
  it('recordRun writes state.json under <runs-dir>/<execution-id>/', async () => {
    await recordRun(makeState());
    const path = getRunStatePath('exec-1');
    expect(path).toBe(join(getRunsDir(), 'exec-1', 'state.json'));
    const persisted = await readRun('exec-1');
    expect(persisted).not.toBeNull();
    expect(persisted?.sprintId).toBe('sprint-a');
    expect(persisted?.status).toBe('running');
  });

  it('updateStatus flips status to terminal and stamps endedAt', async () => {
    await recordRun(makeState());
    await updateStatus('exec-1', 'completed');
    const persisted = await readRun('exec-1');
    expect(persisted?.status).toBe('completed');
    expect(persisted?.endedAt).toBeDefined();
  });

  it('listRuns returns only valid state.json entries and skips hidden dirs', async () => {
    await recordRun(makeState({ executionId: 'exec-1' }));
    await recordRun(makeState({ executionId: 'exec-2', sprintId: 'sprint-b' }));
    // Manually create a hidden sibling dir that listRuns should skip.
    await mkdir(join(getRunsDir(), '.sprint-locks'), { recursive: true });

    const runs = await listRuns();
    expect(runs.map((r) => r.executionId).sort()).toEqual(['exec-1', 'exec-2']);
  });

  it('listRuns returns empty when runs dir does not exist', async () => {
    const runs = await listRuns();
    expect(runs).toEqual([]);
  });
});

describe('runs-store — sprint lock', () => {
  it('claimSprintLock writes a lock file with the current pid', async () => {
    await claimSprintLock({ sprintId: 'sprint-a', executionId: 'exec-1', projectName: 'alpha' });
    const content = await readFile(getSprintLockPath('sprint-a'), 'utf-8');
    const parsed = JSON.parse(content) as { pid: number; sprintId: string; projectName: string; executionId: string };
    expect(parsed.pid).toBe(process.pid);
    expect(parsed.sprintId).toBe('sprint-a');
    expect(parsed.projectName).toBe('alpha');
    expect(parsed.executionId).toBe('exec-1');
  });

  it('claimSprintLock throws ExecutionAlreadyRunningError when a live PID holds the lock', async () => {
    await claimSprintLock({ sprintId: 'sprint-a', executionId: 'exec-1', projectName: 'alpha' });
    await expect(
      claimSprintLock({ sprintId: 'sprint-a', executionId: 'exec-2', projectName: 'alpha' })
    ).rejects.toBeInstanceOf(ExecutionAlreadyRunningError);
  });

  it('claimSprintLock reaps a stale lock (dead PID) and succeeds', async () => {
    // Write a lock file pointing at a PID that almost certainly does not exist.
    const stalePid = 1; // init — but we manually craft a clearly-dead PID below.
    // 0x7FFFFFFF is the 32-bit signed max — guaranteed-not-running on test hosts.
    const deadPid = 2_147_483_647;
    expect(isProcessAlive(deadPid)).toBe(false);
    expect(stalePid).toBeGreaterThan(0); // sanity — not used directly

    await mkdir(join(getRunsDir(), '.sprint-locks'), { recursive: true });
    await writeFile(
      getSprintLockPath('sprint-a'),
      JSON.stringify({
        executionId: 'ghost',
        pid: deadPid,
        sprintId: 'sprint-a',
        projectName: 'alpha',
        acquiredAt: '2026-04-29T00:00:00.000Z',
      })
    );

    await claimSprintLock({ sprintId: 'sprint-a', executionId: 'exec-fresh', projectName: 'alpha' });
    const content = await readFile(getSprintLockPath('sprint-a'), 'utf-8');
    const parsed = JSON.parse(content) as { pid: number; executionId: string };
    expect(parsed.pid).toBe(process.pid);
    expect(parsed.executionId).toBe('exec-fresh');
  });

  it('releaseSprintLock removes the lock file and is a no-op when missing', async () => {
    await claimSprintLock({ sprintId: 'sprint-a', executionId: 'exec-1', projectName: 'alpha' });
    await releaseSprintLock('sprint-a');
    const content = await readFile(getSprintLockPath('sprint-a'), 'utf-8').catch((err: unknown) =>
      err instanceof Error && 'code' in err ? (err as NodeJS.ErrnoException).code : 'unknown'
    );
    expect(content).toBe('ENOENT');
    // Calling again is safe.
    await expect(releaseSprintLock('sprint-a')).resolves.toBeUndefined();
  });
});

describe('runs-store — pruneStale', () => {
  it('flips dead-PID running entries to cancelled and removes their sprint locks', async () => {
    const deadPid = 2_147_483_647;
    expect(isProcessAlive(deadPid)).toBe(false);

    await recordRun(makeState({ executionId: 'exec-zombie', pid: deadPid }));
    // Pre-stage a stale sprint lock owned by the same dead pid.
    await mkdir(join(getRunsDir(), '.sprint-locks'), { recursive: true });
    await writeFile(
      getSprintLockPath('sprint-a'),
      JSON.stringify({
        executionId: 'exec-zombie',
        pid: deadPid,
        sprintId: 'sprint-a',
        projectName: 'alpha',
        acquiredAt: '2026-04-29T00:00:00.000Z',
      })
    );

    const result = await pruneStale();
    expect(result.prunedRunIds).toContain('exec-zombie');
    expect(result.prunedLockSprintIds).toContain('sprint-a');

    const persisted = await readRun('exec-zombie');
    expect(persisted?.status).toBe('cancelled');
    expect(persisted?.endedAt).toBeDefined();
  });

  it('leaves live-PID entries alone', async () => {
    await recordRun(makeState({ executionId: 'exec-live', pid: process.pid }));
    const result = await pruneStale();
    expect(result.prunedRunIds).not.toContain('exec-live');
    const persisted = await readRun('exec-live');
    expect(persisted?.status).toBe('running');
  });
});

describe('runs-store — id safety', () => {
  it('rejects path-traversing execution ids', async () => {
    await expect(recordRun(makeState({ executionId: '../escape' }))).rejects.toThrow(/Path traversal/);
  });

  it('rejects path-traversing sprint ids in claimSprintLock', async () => {
    await expect(
      claimSprintLock({ sprintId: '../escape', executionId: 'exec-1', projectName: 'alpha' })
    ).rejects.toThrow(/Path traversal/);
  });
});
