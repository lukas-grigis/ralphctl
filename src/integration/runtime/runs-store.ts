/**
 * File-backed registry of sprint executions across processes.
 *
 * Each running or terminal execution gets its own directory under
 * `~/.ralphctl/runs/<execution-id>/`:
 *
 *   state.json   — public projection of the run (executionId, pid, sprintId,
 *                  projectName, status, startedAt, endedAt, logPath?).
 *   state.json.lock — written transparently by `withFileLock` while the
 *                  state file is being read-modified-written.
 *
 * A separate per-sprint claim file lives at
 * `~/.ralphctl/runs/.sprint-locks/<sprint-id>.lock`. Acquiring the claim is
 * how a process announces "I am about to start sprint X." The claim records
 * the owning PID so a fresh process can detect a still-live owner via
 * `process.kill(pid, 0)` and refuse to double-start, while crashed owners
 * leave a stale claim that the next `pruneStale()` reaps.
 *
 * The store is intentionally small and synchronous-feeling — every function
 * lives at the FS boundary and works without any other ralphctl runtime
 * being mounted. CLI commands like `sprint list-runs` and `sprint stop`
 * read/write directly through this module.
 */

import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ExecutionAlreadyRunningError } from '@src/domain/errors.ts';
import { withFileLock } from '@src/integration/persistence/file-lock.ts';
import { getDataDir } from '@src/integration/persistence/paths.ts';

export const RunStatusSchema = z.enum(['running', 'completed', 'failed', 'cancelled']);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunStateSchema = z.object({
  executionId: z.string().min(1),
  pid: z.number().int().positive(),
  sprintId: z.string().min(1),
  projectName: z.string().min(1),
  status: RunStatusSchema,
  startedAt: z.string().min(1),
  endedAt: z.string().min(1).optional(),
  logPath: z.string().min(1).optional(),
});
export type RunState = z.infer<typeof RunStateSchema>;

const SprintLockInfoSchema = z.object({
  executionId: z.string().min(1),
  pid: z.number().int().positive(),
  sprintId: z.string().min(1),
  projectName: z.string().min(1),
  acquiredAt: z.string().min(1),
});
type SprintLockInfo = z.infer<typeof SprintLockInfoSchema>;

const SPRINT_LOCKS_SUBDIR = '.sprint-locks';

function assertSafeId(id: string, label: string): void {
  if (!id || id.includes('/') || id.includes('\\') || id.includes('..') || id.includes('\0')) {
    throw new Error(`Path traversal detected in ${label}: ${id}`);
  }
}

export function getRunsDir(): string {
  return join(getDataDir(), 'runs');
}

export function getRunDir(executionId: string): string {
  assertSafeId(executionId, 'execution id');
  return join(getRunsDir(), executionId);
}

export function getRunStatePath(executionId: string): string {
  return join(getRunDir(executionId), 'state.json');
}

function getSprintLocksDir(): string {
  return join(getRunsDir(), SPRINT_LOCKS_SUBDIR);
}

export function getSprintLockPath(sprintId: string): string {
  assertSafeId(sprintId, 'sprint id');
  return join(getSprintLocksDir(), `${sprintId}.lock`);
}

/**
 * `process.kill(pid, 0)` doesn't actually kill — it asks the kernel whether
 * the PID is reachable. ESRCH means the process is gone; EPERM means it
 * exists but we can't signal it (still alive from our perspective).
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = err instanceof Error && 'code' in err ? (err as NodeJS.ErrnoException).code : undefined;
    if (code === 'EPERM') return true;
    return false;
  }
}

async function writeStateFile(executionId: string, state: RunState): Promise<void> {
  const validated = RunStateSchema.parse(state);
  const dir = getRunDir(executionId);
  await mkdir(dir, { recursive: true });
  const path = getRunStatePath(executionId);
  const lockResult = await withFileLock(path, async () => {
    await writeFile(path, JSON.stringify(validated, null, 2) + '\n', { mode: 0o600 });
  });
  if (!lockResult.ok) throw lockResult.error;
}

export async function recordRun(state: RunState): Promise<void> {
  await writeStateFile(state.executionId, state);
}

export async function readRun(executionId: string): Promise<RunState | null> {
  try {
    const content = await readFile(getRunStatePath(executionId), 'utf-8');
    const parsed: unknown = JSON.parse(content);
    const result = RunStateSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch (err) {
    const code = err instanceof Error && 'code' in err ? (err as NodeJS.ErrnoException).code : undefined;
    if (code === 'ENOENT') return null;
    return null;
  }
}

export async function updateStatus(
  executionId: string,
  status: RunStatus,
  patch: { endedAt?: string; logPath?: string } = {}
): Promise<void> {
  const path = getRunStatePath(executionId);
  const lockResult = await withFileLock(path, async () => {
    const current = await readRun(executionId);
    if (!current) return;
    const endedAt = patch.endedAt ?? current.endedAt ?? (status !== 'running' ? new Date().toISOString() : undefined);
    const next: RunState = {
      ...current,
      status,
      ...(endedAt !== undefined ? { endedAt } : {}),
      ...(patch.logPath !== undefined ? { logPath: patch.logPath } : {}),
    };
    const validated = RunStateSchema.parse(next);
    await writeFile(path, JSON.stringify(validated, null, 2) + '\n', { mode: 0o600 });
  });
  if (!lockResult.ok) throw lockResult.error;
}

export async function listRuns(): Promise<RunState[]> {
  let entries: string[];
  try {
    entries = await readdir(getRunsDir());
  } catch (err) {
    const code = err instanceof Error && 'code' in err ? (err as NodeJS.ErrnoException).code : undefined;
    if (code === 'ENOENT') return [];
    throw err;
  }
  const states: RunState[] = [];
  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    const state = await readRun(entry);
    if (state) states.push(state);
  }
  return states;
}

async function readSprintLock(sprintId: string): Promise<SprintLockInfo | null> {
  try {
    const content = await readFile(getSprintLockPath(sprintId), 'utf-8');
    const parsed: unknown = JSON.parse(content);
    const result = SprintLockInfoSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/**
 * Atomically take the per-sprint claim for `sprintId`. Throws
 * `ExecutionAlreadyRunningError` when a live PID already holds the claim.
 * A stale claim (dead PID) is reaped and the call retries.
 */
export async function claimSprintLock(args: {
  sprintId: string;
  executionId: string;
  projectName: string;
}): Promise<void> {
  const lockPath = getSprintLockPath(args.sprintId);
  await mkdir(getSprintLocksDir(), { recursive: true });

  const info: SprintLockInfo = {
    executionId: args.executionId,
    pid: process.pid,
    sprintId: args.sprintId,
    projectName: args.projectName,
    acquiredAt: new Date().toISOString(),
  };

  const MAX_ATTEMPTS = 3;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      await writeFile(lockPath, JSON.stringify(info, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      return;
    } catch (err) {
      const code = err instanceof Error && 'code' in err ? (err as NodeJS.ErrnoException).code : undefined;
      if (code !== 'EEXIST') throw err;

      const existing = await readSprintLock(args.sprintId);
      if (existing && isProcessAlive(existing.pid)) {
        throw new ExecutionAlreadyRunningError(existing.projectName, existing.executionId);
      }
      try {
        await unlink(lockPath);
      } catch {
        // Lost the race — another reaper grabbed it. Retry.
      }
    }
  }
  throw new Error(`Failed to claim sprint lock for sprint '${args.sprintId}' after ${String(MAX_ATTEMPTS)} attempts`);
}

export async function releaseSprintLock(sprintId: string): Promise<void> {
  try {
    await unlink(getSprintLockPath(sprintId));
  } catch (err) {
    const code = err instanceof Error && 'code' in err ? (err as NodeJS.ErrnoException).code : undefined;
    if (code === 'ENOENT') return;
    throw err;
  }
}

/**
 * Reconcile FS state against the live process table.
 *
 * Any state.json with `status === 'running'` whose PID is no longer alive
 * is flipped to `cancelled` (the daemon crashed or was killed externally).
 * Stale sprint-lock files are unlinked so subsequent `claimSprintLock`
 * calls can proceed.
 */
export async function pruneStale(): Promise<{ prunedRunIds: string[]; prunedLockSprintIds: string[] }> {
  const prunedRunIds: string[] = [];
  const prunedLockSprintIds: string[] = [];

  const runs = await listRuns();
  for (const run of runs) {
    if (run.status === 'running' && !isProcessAlive(run.pid)) {
      try {
        await updateStatus(run.executionId, 'cancelled', { endedAt: new Date().toISOString() });
        prunedRunIds.push(run.executionId);
      } catch {
        // Best-effort sweep — keep going.
      }
    }
  }

  let lockEntries: string[] = [];
  try {
    lockEntries = await readdir(getSprintLocksDir());
  } catch (err) {
    const code = err instanceof Error && 'code' in err ? (err as NodeJS.ErrnoException).code : undefined;
    if (code !== 'ENOENT') throw err;
  }
  for (const entry of lockEntries) {
    if (!entry.endsWith('.lock')) continue;
    const sprintId = entry.slice(0, -'.lock'.length);
    if (!sprintId) continue;
    const info = await readSprintLock(sprintId);
    if (!info || !isProcessAlive(info.pid)) {
      try {
        await unlink(getSprintLockPath(sprintId));
        prunedLockSprintIds.push(sprintId);
      } catch {
        // Best-effort sweep — keep going.
      }
    }
  }

  return { prunedRunIds, prunedLockSprintIds };
}
