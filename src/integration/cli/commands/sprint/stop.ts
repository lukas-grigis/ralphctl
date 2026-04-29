import {
  isProcessAlive,
  listRuns,
  readRun,
  releaseSprintLock,
  updateStatus,
} from '@src/integration/runtime/runs-store.ts';
import { colors } from '@src/integration/ui/theme/theme.ts';
import { log, showError, showSuccess, showWarning } from '@src/integration/ui/theme/ui.ts';

/** Send SIGTERM, wait for the daemon to exit, fall back to SIGKILL. */
const DEFAULT_GRACE_MS = 10_000;
const POLL_INTERVAL_MS = 100;

interface StopOptions {
  /** Resolve a run by id or sprintId. */
  id: string;
  /** Override the grace window between SIGTERM and SIGKILL (defaults to 10 s). */
  graceMs?: number;
  /** Override the polling interval (defaults to 100 ms). */
  pollMs?: number;
}

type KillFn = (pid: number, signal: NodeJS.Signals | 0) => void;

interface StopDeps {
  kill?: KillFn;
  now?: () => number;
}

function defaultKill(pid: number, signal: NodeJS.Signals | 0): void {
  process.kill(pid, signal);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolve `id` to a run. Accepts either an execution id (preferred) or a
 * sprint id (convenience — picks the most recent running run for that sprint
 * so users don't have to copy a UUID out of `list-runs`).
 */
async function resolveRun(id: string): Promise<{
  run: import('@src/integration/runtime/runs-store.ts').RunState | null;
  matchedBy: 'executionId' | 'sprintId' | null;
}> {
  const direct = await readRun(id);
  if (direct) return { run: direct, matchedBy: 'executionId' };

  const all = await listRuns();
  const matches = all.filter((r) => r.sprintId === id);
  if (matches.length === 0) return { run: null, matchedBy: null };
  const running = matches.find((r) => r.status === 'running');
  if (running) return { run: running, matchedBy: 'sprintId' };
  // No running match — return the most recent terminal one.
  const recent = [...matches].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  return { run: recent ?? null, matchedBy: 'sprintId' };
}

export async function stopRun(
  options: StopOptions,
  deps: StopDeps = {}
): Promise<{ status: 'graceful' | 'forced' | 'already-terminal' | 'not-found' }> {
  const kill = deps.kill ?? defaultKill;
  const now = deps.now ?? ((): number => Date.now());
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const pollMs = options.pollMs ?? POLL_INTERVAL_MS;

  const resolved = await resolveRun(options.id);
  if (!resolved.run) return { status: 'not-found' };
  const run = resolved.run;

  if (run.status !== 'running') {
    return { status: 'already-terminal' };
  }

  if (!isProcessAlive(run.pid)) {
    // Daemon vanished — reconcile FS state and return.
    await updateStatus(run.executionId, 'cancelled', { endedAt: new Date().toISOString() });
    await releaseSprintLock(run.sprintId);
    return { status: 'graceful' };
  }

  try {
    kill(run.pid, 'SIGTERM');
  } catch {
    // PID went away between liveness check and signal — same outcome as
    // graceful exit.
    await updateStatus(run.executionId, 'cancelled', { endedAt: new Date().toISOString() });
    await releaseSprintLock(run.sprintId);
    return { status: 'graceful' };
  }

  const deadline = now() + graceMs;
  while (now() < deadline) {
    await sleep(pollMs);
    if (!isProcessAlive(run.pid)) {
      await updateStatus(run.executionId, 'cancelled', { endedAt: new Date().toISOString() });
      await releaseSprintLock(run.sprintId);
      return { status: 'graceful' };
    }
  }

  // Grace window elapsed — escalate.
  try {
    kill(run.pid, 'SIGKILL');
  } catch {
    // ignore — we'll mark cancelled either way.
  }
  await updateStatus(run.executionId, 'cancelled', { endedAt: new Date().toISOString() });
  await releaseSprintLock(run.sprintId);
  return { status: 'forced' };
}

export async function sprintStopCommand(args: string[]): Promise<void> {
  const id = args[0];
  if (!id) {
    showError('Missing run id. Usage: ralphctl sprint stop <run-id-or-sprint-id>');
    return;
  }

  const result = await stopRun({ id });
  switch (result.status) {
    case 'not-found':
      showError(`No run found matching '${id}'.`);
      log.dim(`  ${colors.muted('?')} Run ${colors.highlight('ralphctl sprint list-runs')} to see active runs.`);
      return;
    case 'already-terminal':
      showWarning(`Run '${id}' is already terminal — nothing to stop.`);
      return;
    case 'graceful':
      showSuccess(`Run '${id}' exited gracefully and was marked cancelled.`);
      return;
    case 'forced':
      showWarning(`Run '${id}' did not exit within the grace window — sent SIGKILL and marked cancelled.`);
      return;
  }
}
