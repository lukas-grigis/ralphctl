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

import { createRefineFlow, type RefineCtx } from '../../chains/refine/refine-flow.ts';
import { Result } from '../../../domain/result.ts';
import { AbsolutePath } from '../../../domain/values/absolute-path.ts';
import { SprintId } from '../../../domain/values/sprint-id.ts';
import type { SharedDeps } from '../../bootstrap/shared-deps.ts';
import { printError } from '../command-runner.ts';
import { EXIT_ERROR, EXIT_SUCCESS, type ExitCode } from '../exit-codes.ts';
import { streamSession } from '../stream-session.ts';

interface SprintRefineFlags {
  readonly sprint: string;
  readonly cwd?: string;
}

export function attachSprintRefine(group: Command, deps: SharedDeps): void {
  group
    .command('refine')
    .description('clarify ticket requirements via AI (per-ticket HITL)')
    .requiredOption('--sprint <id>', 'sprint id')
    .option('--cwd <abs>', 'working directory for the AI session', process.cwd())
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
  const cwd = AbsolutePath.parse(opts.cwd ?? process.cwd());
  if (!cwd.ok) {
    printError(deps, cwd.error);
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

  const flow = createRefineFlow(deps, {
    sprintId: sprintId.value,
    cwd: cwd.value,
    pendingTickets,
  });
  void Result; // typescript-result imported for clarity in adjacent files

  return streamSession<RefineCtx>({
    sessionManager: deps.sessionManager,
    label: `refine ${sprintId.value}`,
    element: flow,
    initialCtx: { sprintId: sprintId.value, cwd: cwd.value },
  });
}
