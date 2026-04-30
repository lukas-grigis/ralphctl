/**
 * `sprint start` — execute every task in an active sprint.
 *
 * The execute chain is per-sprint and parallel-fans-out per task. The CLI
 * pre-loads the sprint + task set so the chain factory can size the
 * Parallel children at construction time.
 *
 * Auto-activation: a `draft` sprint is activated first via
 * {@link ActivateSprintUseCase} so the chain's `assert-active` guard
 * passes. Brief calls this out as application-layer responsibility.
 *
 * Exit codes:
 *  - EXIT_SUCCESS on a clean run.
 *  - EXIT_NO_TASKS when the sprint has zero tasks (planning hasn't run).
 *  - EXIT_ERROR otherwise.
 */
import type { Command } from 'commander';
import * as c from 'colorette';

import { ActivateSprintUseCase } from '../../../business/usecases/sprint/activate-sprint.ts';
import { createExecuteFlow, type ExecuteCtx } from '../../chains/execute/execute-flow.ts';
import { AbsolutePath } from '../../../domain/values/absolute-path.ts';
import { IsoTimestamp } from '../../../domain/values/iso-timestamp.ts';
import { SprintId } from '../../../domain/values/sprint-id.ts';
import type { SharedDeps } from '../../bootstrap/shared-deps.ts';
import { printError } from '../command-runner.ts';
import { EXIT_ERROR, EXIT_NO_TASKS, EXIT_SUCCESS, type ExitCode } from '../exit-codes.ts';
import { streamSession } from '../stream-session.ts';

interface SprintStartFlags {
  readonly sprint: string;
  readonly cwd?: string;
  readonly branch?: string;
  readonly checkScript?: string;
  readonly concurrency?: string;
}

export function attachSprintStart(group: Command, deps: SharedDeps): void {
  group
    .command('start')
    .description('execute the active sprint')
    .requiredOption('--sprint <id>', 'sprint id')
    .option('--cwd <abs>', 'working directory for AI sessions', process.cwd())
    .option('--branch <name>', 'expected branch name (empty = no branch enforcement)', '')
    .option('--check-script <cmd>', 'sprint-start check script')
    .option('--concurrency <n>', 'task concurrency cap', '4')
    .action(async (opts: SprintStartFlags) => {
      const code = await runSprintStart(deps, opts);
      if (code !== EXIT_SUCCESS) process.exitCode = code;
    });
}

export async function runSprintStart(deps: SharedDeps, opts: SprintStartFlags): Promise<ExitCode> {
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

  // Auto-activate: draft → active so the executor's `assert-active`
  // guard passes. The chain re-loads from disk after activation.
  const sprintLoaded = await deps.sprintRepo.findById(sprintId.value);
  if (!sprintLoaded.ok) {
    printError(deps, sprintLoaded.error);
    return EXIT_ERROR;
  }
  if (sprintLoaded.value.status === 'draft') {
    const activate = await new ActivateSprintUseCase(deps.sprintRepo).execute({
      id: sprintId.value,
      now: IsoTimestamp.now(),
    });
    if (!activate.ok) {
      printError(deps, activate.error);
      return EXIT_ERROR;
    }
    process.stdout.write(c.dim('auto-activated draft sprint') + '\n');
  }

  const sprint = await deps.sprintRepo.findById(sprintId.value);
  if (!sprint.ok) {
    printError(deps, sprint.error);
    return EXIT_ERROR;
  }
  const tasks = await deps.taskRepo.findBySprintId(sprintId.value);
  if (!tasks.ok) {
    printError(deps, tasks.error);
    return EXIT_ERROR;
  }
  if (tasks.value.length === 0) {
    process.stderr.write(c.yellow('no tasks to execute — run `ralphctl sprint plan` first') + '\n');
    return EXIT_NO_TASKS;
  }

  const concurrency = Number.parseInt(opts.concurrency ?? '4', 10);
  const expectedBranch = opts.branch ?? '';

  const flow = createExecuteFlow(deps, {
    sprintId: sprintId.value,
    cwd: cwd.value,
    expectedBranch,
    sprint: sprint.value,
    tasks: tasks.value,
    concurrency: Number.isFinite(concurrency) && concurrency > 0 ? concurrency : 4,
    ...(opts.checkScript !== undefined ? { checkScript: opts.checkScript } : {}),
  });

  process.stdout.write(
    c.bold('Execute') + ` — ${String(tasks.value.length)} task(s) on sprint ${c.dim(sprintId.value)}\n`
  );

  return streamSession<ExecuteCtx>({
    sessionManager: deps.sessionManager,
    label: `execute ${sprintId.value}`,
    element: flow,
    initialCtx: {
      sprintId: sprintId.value,
      cwd: cwd.value,
      expectedBranch,
      ...(opts.checkScript !== undefined ? { checkScript: opts.checkScript } : {}),
    },
  });
}
