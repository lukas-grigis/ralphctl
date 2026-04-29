/**
 * Hidden CLI command — `ralphctl sprint __daemon-run <sprintId>`.
 *
 * The daemon-spawn helper (`src/integration/runtime/daemon-spawn.ts`) detaches
 * a child Node process and re-execs the same CLI with this subcommand. The
 * daemon then drives the standard execute pipeline through the in-memory
 * `ExecutionRegistryPort`, which records itself in the file-backed runs-store
 * with the daemon's PID. From then on `ralphctl sprint list-runs` /
 * `sprint stop` / `sprint attach` can find and steer the daemon by sprint id.
 *
 * Invariant: the daemon never mounts Ink — its stdout / stderr are redirected
 * to a log file by the parent. The standard PlainTextSink output is what
 * ends up in that log.
 */

import { parseSprintStartArgs } from '@src/integration/cli/commands/sprint/start.ts';
import { getSharedDeps } from '@src/integration/bootstrap.ts';
import { ExecutionAlreadyRunningError } from '@src/domain/errors.ts';
import { EXIT_ERROR, EXIT_SUCCESS, exitWithCode } from '@src/domain/exit-codes.ts';
import type { RunningExecution } from '@src/business/ports/execution-registry.ts';

/**
 * Args layout: `<sprintId> [--flag value ...]`. The flags share the same
 * vocabulary as `sprint start` so detach-and-respawn round-trips losslessly.
 */
export async function sprintDaemonRunCommand(args: string[]): Promise<void> {
  const sprintId = args[0];
  if (!sprintId) {
    console.error('sprint __daemon-run: missing <sprintId>');
    exitWithCode(EXIT_ERROR);
    return;
  }

  const parsed = parseSprintStartArgs(args.slice(1));
  if (!parsed.ok) {
    console.error(`sprint __daemon-run: ${parsed.error}`);
    exitWithCode(EXIT_ERROR);
    return;
  }

  // Install the SIGTERM bridge BEFORE start() so a `sprint stop` arriving
  // before the listener loop binds still routes through registry.cancel()
  // rather than killing the daemon abruptly (leaving in_progress tasks
  // stuck and skipping the cancellation drain).
  installDaemonSignalHandlers();

  const shared = getSharedDeps();
  const registry = shared.executionRegistry;

  let execution: RunningExecution;
  try {
    execution = await registry.start({ sprintId, options: parsed.value.options });
  } catch (err) {
    if (err instanceof ExecutionAlreadyRunningError) {
      console.error(`sprint __daemon-run: ${err.message}`);
      exitWithCode(EXIT_ERROR);
      return;
    }
    console.error(`sprint __daemon-run: ${err instanceof Error ? err.message : String(err)}`);
    exitWithCode(EXIT_ERROR);
    return;
  }

  // Wait until the registry transitions the execution to a terminal status.
  // The pipeline runs in the registry's background `pipelinePromise` — we
  // observe completion through the listener stream rather than reaching into
  // private fields.
  const terminalStatus = await new Promise<RunningExecution['status']>((resolve) => {
    const current = registry.get(execution.id);
    if (current && current.status !== 'running') {
      resolve(current.status);
      return;
    }
    const unsubscribe = registry.subscribe((entry) => {
      if (entry.id !== execution.id) return;
      if (entry.status === 'running') return;
      unsubscribe();
      resolve(entry.status);
    });
  });

  if (terminalStatus === 'completed') {
    exitWithCode(EXIT_SUCCESS);
    return;
  }
  exitWithCode(EXIT_ERROR);
}

/**
 * Install a SIGTERM handler that asks the registry to cancel the running
 * execution gracefully. Exposed so the CLI registration can install it once
 * at process start (rather than at command-run time so a SIGTERM arriving
 * during `start()` itself is not lost).
 */
export function installDaemonSignalHandlers(): void {
  process.on('SIGTERM', () => {
    try {
      const shared = getSharedDeps();
      for (const entry of shared.executionRegistry.list()) {
        if (entry.status === 'running') shared.executionRegistry.cancel(entry.id);
      }
    } catch {
      // Best-effort — if shared deps aren't initialised, fall through to default.
    }
  });
}
