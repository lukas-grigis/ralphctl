/**
 * `ralphctl sprint attach <id>` — read-only live view of a backgrounded
 * daemon. Resolves `id` against the file-backed runs-store (preferring an
 * exact executionId, falling back to a sprintId match) and mounts the Ink
 * TUI in attach mode. The mounted `<AttachView />` polls runs-store + tasks.json
 * and tails the daemon's log file for streaming output.
 *
 * Non-TTY callers see a single-line status report instead of the Ink mount.
 */

import { listRuns, readRun, type RunState } from '@src/integration/runtime/runs-store.ts';
import { log, showError, showWarning } from '@src/integration/ui/theme/ui.ts';

export interface SprintAttachDeps {
  readonly mountInk?: (executionId: string) => Promise<{ fallback: boolean }>;
}

async function resolveRunByIdOrSprint(id: string): Promise<RunState | null> {
  const direct = await readRun(id);
  if (direct) return direct;
  const all = await listRuns();
  // Prefer the most-recent running daemon for this sprint id.
  const running = all
    .filter((r) => r.sprintId === id && r.status === 'running')
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  if (running) return running;
  // Fall back to the most-recent matching run regardless of status so the
  // user sees a clear "this run is already terminal" message rather than a
  // generic not-found.
  return all.filter((r) => r.sprintId === id).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] ?? null;
}

export async function sprintAttachCommand(args: string[], deps: SprintAttachDeps = {}): Promise<void> {
  const id = args[0];
  if (!id) {
    showError('Missing run id. Usage: ralphctl sprint attach <run-id-or-sprint-id>');
    log.dim('  Run ralphctl sprint list-runs to see available daemons.');
    return;
  }

  const run = await resolveRunByIdOrSprint(id);
  if (!run) {
    showError(`No run found matching '${id}'.`);
    log.dim('  Run ralphctl sprint list-runs to see available daemons.');
    return;
  }

  if (run.status !== 'running') {
    showWarning(`Run '${run.executionId}' is ${run.status} — nothing live to attach to.`);
    log.dim(`  Started: ${run.startedAt}${run.endedAt ? ` · Ended: ${run.endedAt}` : ''}`);
    return;
  }

  const mount = deps.mountInk ?? defaultMountInk;
  const { fallback } = await mount(run.executionId);
  if (fallback) {
    log.info(`Daemon ${run.executionId} (sprint ${run.sprintId}) is running. pid ${String(run.pid)}`);
    log.info(`  Project: ${run.projectName}`);
    if (run.logPath) {
      log.info(`  Tail with: tail -f ${run.logPath}`);
    }
  }
}

async function defaultMountInk(executionId: string): Promise<{ fallback: boolean }> {
  const { mountInkApp } = await import('@src/integration/ui/tui/runtime/mount.tsx');
  return mountInkApp({ initialView: 'attach', executionId });
}
