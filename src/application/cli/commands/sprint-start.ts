/**
 * `sprint start` — execute every task in an active sprint.
 *
 * The execute chain iterates tasks in dependency order one at a time. The
 * CLI pre-loads the sprint + task set so the chain factory can topologically
 * sort the task list at construction time.
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

import { ActivateSprintUseCase } from '@src/business/usecases/sprint/activate-sprint.ts';
import { createExecuteFlow, type ExecuteCtx } from '@src/application/chains/execute/execute-flow.ts';
import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';
import { SprintId } from '@src/domain/values/sprint-id.ts';
import type { SharedDeps } from '@src/application/bootstrap/shared-deps.ts';
import { printError } from '@src/application/cli/command-runner.ts';
import { EXIT_ERROR, EXIT_NO_TASKS, EXIT_SUCCESS, type ExitCode } from '@src/application/cli/exit-codes.ts';
import { streamSession } from '@src/application/cli/stream-session.ts';

interface SprintStartFlags {
  readonly sprint: string;
  readonly cwd?: string;
  /**
   * When set (boolean flag), pre-seed `sprint.branch` with
   * `ralphctl/<sprint-id>` so the chain's `resolve-branch` leaf skips
   * the prompt. Mutually exclusive with `--branch-name`; when both are
   * set, `--branch-name` wins.
   */
  readonly branch?: boolean;
  /**
   * When set, pre-seed `sprint.branch` with the given name. Skips the
   * chain's prompt. Validated via `ExternalPort.isValidBranchName`.
   */
  readonly branchName?: string;
  readonly checkScript?: string;
  /**
   * Disable per-task auto-commit. The harness usually commits each task
   * after the evaluator round settles; `--no-commit` leaves the dirty
   * tree for the user to stage manually.
   */
  readonly commit?: boolean;
}

export function attachSprintStart(group: Command, deps: SharedDeps): void {
  group
    .command('start')
    .description('execute the active sprint')
    .requiredOption('--sprint <id>', 'sprint id')
    .option('--cwd <abs>', 'working directory for AI sessions', process.cwd())
    .option('--branch', 'auto-generate sprint branch name (`ralphctl/<sprint-id>`)')
    .option('--branch-name <name>', 'use a custom branch name')
    .option(
      '--check-script <cmd>',
      'override the post-task check script for every task (otherwise auto-sourced from each repo)'
    )
    .option('--no-commit', 'do not auto-commit each task after the evaluator round')
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

  let sprint = await deps.sprintRepo.findById(sprintId.value);
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

  // Pre-seed sprint.branch when the user passed --branch / --branch-name
  // so the chain's `resolve-branch` leaf skips the prompt. The leaf
  // creates the branch in every repo path itself; we just persist the
  // user's intent here. `--branch-name` wins over `--branch` when both
  // are set (an explicit name beats auto-generation).
  if (sprint.value.branch === null && (opts.branchName !== undefined || opts.branch === true)) {
    const desired =
      opts.branchName !== undefined && opts.branchName.length > 0
        ? opts.branchName
        : deps.external.generateBranchName(sprintId.value);
    if (!deps.external.isValidBranchName(desired)) {
      process.stderr.write(c.red('error') + ` invalid branch name: ${desired}\n`);
      return EXIT_ERROR;
    }
    const transitioned = sprint.value.setBranch(desired);
    if (!transitioned.ok) {
      printError(deps, transitioned.error);
      return EXIT_ERROR;
    }
    const saved = await deps.sprintRepo.save(transitioned.value);
    if (!saved.ok) {
      printError(deps, saved.error);
      return EXIT_ERROR;
    }
    sprint = await deps.sprintRepo.findById(sprintId.value);
    if (!sprint.ok) {
      printError(deps, sprint.error);
      return EXIT_ERROR;
    }
  }

  // Seed ctx.expectedBranch with the persisted value (resume case) or '' for
  // a fresh run. The chain's `resolve-branch` leaf overwrites the value
  // after prompting when sprint.branch is still null.
  const expectedBranch = sprint.value.branch ?? '';

  // Commander's `--no-commit` sets `opts.commit === false` when the user
  // passes the flag; otherwise the option is absent (treated as true).
  const noCommit = opts.commit === false;

  const flow = createExecuteFlow(deps, {
    sprintId: sprintId.value,
    cwd: cwd.value,
    expectedBranch,
    sprint: sprint.value,
    tasks: tasks.value,
    ...(opts.checkScript !== undefined ? { checkScript: opts.checkScript } : {}),
    ...(noCommit ? { noCommit: true } : {}),
  });

  process.stdout.write(
    c.bold('Execute') + ` — ${String(tasks.value.length)} task(s) on sprint ${c.dim(sprintId.value)}\n`
  );

  return streamSession<ExecuteCtx>({
    sessionManager: deps.sessionManager,
    label: `execute ${sprintId.value}`,
    element: flow,
    prompt: deps.prompt,
    initialCtx: {
      sprintId: sprintId.value,
      cwd: cwd.value,
      expectedBranch,
      ...(opts.checkScript !== undefined ? { checkScript: opts.checkScript } : {}),
      ...(noCommit ? { noCommit: true } : {}),
    },
  });
}
