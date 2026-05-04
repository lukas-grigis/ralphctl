/**
 * `sprint refine` — drive the per-ticket refinement chain.
 *
 * Loads the sprint, filters tickets to `requirementStatus === 'pending'`,
 * builds a `RefineCtx`-shaped chain via {@link createRefineFlow}, and
 * launches it via {@link SessionManagerPort}. Streams runner events to
 * stdout until the chain settles.
 */
import type { Command } from 'commander';
import * as c from 'colorette';

import { createRefineFlow, type RefineCtx } from '@src/application/chains/refine/refine-flow.ts';
import { Result } from '@src/domain/result.ts';
import { SprintId } from '@src/domain/values/sprint-id.ts';
import type { SharedDeps } from '@src/application/bootstrap/shared-deps.ts';
import { printError } from '@src/application/cli/command-runner.ts';
import { EXIT_ERROR, EXIT_SUCCESS, type ExitCode } from '@src/application/cli/exit-codes.ts';
import { streamSession } from '@src/application/cli/stream-session.ts';

interface SprintRefineFlags {
  readonly sprint: string;
  /** When true, force headless mode regardless of TTY — for CI / non-interactive contexts. */
  readonly auto?: boolean;
}

export function attachSprintRefine(group: Command, deps: SharedDeps): void {
  group
    .command('refine')
    .description('clarify ticket requirements via AI (per-ticket HITL)')
    .requiredOption('--sprint <id>', 'sprint id')
    .option('--auto', 'run headless — Claude decides what a human would have answered (CI / batch mode)')
    .action(async (opts: SprintRefineFlags) => {
      const code = await runSprintRefine(deps, opts);
      if (code !== EXIT_SUCCESS) process.exitCode = code;
    });
}

export async function runSprintRefine(deps: SharedDeps, opts: SprintRefineFlags): Promise<ExitCode> {
  const sprintId = SprintId.parse(opts.sprint);
  if (!sprintId.ok) {
    printError(deps, sprintId.error);
    return EXIT_ERROR;
  }

  const sprintResult = await deps.sprintRepo.findById(sprintId.value);
  if (!sprintResult.ok) {
    printError(deps, sprintResult.error);
    return EXIT_ERROR;
  }
  const pendingTickets = sprintResult.value.tickets.filter((t) => t.requirementStatus === 'pending');
  if (pendingTickets.length === 0) {
    process.stdout.write(c.dim('No pending tickets — nothing to refine.') + '\n');
    return EXIT_SUCCESS;
  }
  process.stdout.write(
    c.bold('Refine') + ` — ${String(pendingTickets.length)} pending ticket(s) on sprint ${c.dim(sprintId.value)}\n`
  );

  // Default: interactive on a TTY, headless otherwise. `--auto` forces
  // headless even on a TTY (the "Claude decides what a human would
  // have answered" mode).
  const ttyInteractive = process.stdout.isTTY && process.env['RALPHCTL_NO_TUI'] !== '1';
  const interactive = opts.auto === true ? false : ttyInteractive;

  const flow = createRefineFlow(deps, {
    sprintId: sprintId.value,
    pendingTickets,
    interactive,
  });
  void Result; // typescript-result imported for clarity in adjacent files

  return streamSession<RefineCtx>({
    sessionManager: deps.sessionManager,
    label: `refine ${sprintId.value}`,
    element: flow,
    initialCtx: { sprintId: sprintId.value, interactive },
  });
}
