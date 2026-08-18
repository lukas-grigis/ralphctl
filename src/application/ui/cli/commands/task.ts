import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import type { Task } from '@src/domain/entity/task.ts';
import { TaskId } from '@src/domain/value/id/task-id.ts';
import { bootstrapCli } from '@src/application/ui/cli/bootstrap.ts';
import { fail } from '@src/application/ui/cli/report-cli-error.ts';
import { pinFallbackNotice, resolveSprintId } from '@src/application/ui/cli/resolve-sprint-selection.ts';
import { unblockTaskUseCase } from '@src/business/task/unblock-task.ts';
import { evaluationArtifactSprintPath, latestRecordedEvaluation } from '@src/business/task/evaluation-artifact.ts';
import { resolveSprintDir } from '@src/integration/persistence/storage.ts';

interface SprintOpt {
  readonly sprint?: string;
}

const SPRINT_OPTION_FLAGS = '-s, --sprint <id>';
const SPRINT_OPTION_DESC = 'sprint id (defaults to the current sprint)';

const listTasksAction = async (opts: SprintOpt): Promise<void> => {
  const { deps, storage } = await bootstrapCli();
  const sprintId = await resolveSprintId(opts.sprint, storage.stateRoot);
  if (!sprintId.ok) {
    fail(sprintId.error.message);
    return;
  }
  if (sprintId.value.fromPin) process.stderr.write(pinFallbackNotice(sprintId.value.sprintId));
  const result = await deps.taskRepo.findBySprintId(sprintId.value.sprintId);
  if (!result.ok) {
    fail(result.error.message);
    return;
  }
  if (result.value.length === 0) {
    process.stdout.write('(no tasks yet — run plan to generate them)\n');
    return;
  }
  for (const t of result.value) {
    process.stdout.write(`${formatTaskLine(t)}\n`);
  }
};

const showTaskAction = async (rawTaskId: string, opts: SprintOpt): Promise<void> => {
  const { deps, storage } = await bootstrapCli();
  const sprintId = await resolveSprintId(opts.sprint, storage.stateRoot);
  if (!sprintId.ok) {
    fail(sprintId.error.message);
    return;
  }
  const taskId = TaskId.parse(rawTaskId);
  if (!taskId.ok) {
    fail(`invalid task id: ${taskId.error.message}`);
    return;
  }
  if (sprintId.value.fromPin) process.stderr.write(pinFallbackNotice(sprintId.value.sprintId));
  const result = await deps.taskRepo.findById(sprintId.value.sprintId, taskId.value);
  if (!result.ok) {
    fail(result.error.message);
    return;
  }
  process.stdout.write(`${JSON.stringify(result.value, null, 2)}\n`);
};

/**
 * Print the latest `evaluation.md` for a task — the evaluator's operator-readable verdict, which
 * before this command was written to disk every round and readable by nothing.
 *
 * ABSENCE IS NOT AN ERROR. A task that never reached the evaluator, a legacy `tasks.json` row that
 * recorded a verdict but no artifact path, and a workspace someone pruned all print one line and
 * exit 0. Only a bad sprint / task id — the operator mistyping the question — exits 1, matching
 * `showTaskAction`. The file body goes to stdout verbatim (an inspection command must not reformat
 * markdown someone may be piping into a pager or a diff); the provenance header goes to stderr so
 * `ralphctl task evaluation <id> > verdict.md` yields exactly the artifact.
 */
const evaluationTaskAction = async (rawTaskId: string, opts: SprintOpt): Promise<void> => {
  const { deps, storage } = await bootstrapCli();
  const sprintId = await resolveSprintId(opts.sprint, storage.stateRoot);
  if (!sprintId.ok) {
    fail(sprintId.error.message);
    return;
  }
  const taskId = TaskId.parse(rawTaskId);
  if (!taskId.ok) {
    fail(`invalid task id: ${taskId.error.message}`);
    return;
  }
  if (sprintId.value.fromPin) process.stderr.write(pinFallbackNotice(sprintId.value.sprintId));
  const loaded = await deps.taskRepo.findById(sprintId.value.sprintId, taskId.value);
  if (!loaded.ok) {
    fail(loaded.error.message);
    return;
  }

  const latest = latestRecordedEvaluation(loaded.value);
  if (latest === undefined) {
    process.stdout.write(`no evaluation recorded for task ${String(taskId.value)}\n`);
    return;
  }
  const relativePath = evaluationArtifactSprintPath(String(taskId.value), latest.file);
  if (relativePath === undefined) {
    process.stdout.write(`no evaluation artifact recorded for attempt ${String(latest.attemptN)} (legacy record)\n`);
    return;
  }
  // Tolerant resolver so both `<id>--<slug>/` and the legacy bare `<id>/` sprint dirs are found.
  const sprintDirPath = await resolveSprintDir(storage.dataRoot, sprintId.value.sprintId);
  if (sprintDirPath === undefined) {
    process.stdout.write(`evaluation artifact not found on disk: ${relativePath}\n`);
    return;
  }
  try {
    const body = await fs.readFile(join(sprintDirPath, relativePath), 'utf8');
    process.stderr.write(`# attempt ${String(latest.attemptN)} · eval ${latest.status} · ${relativePath}\n`);
    process.stdout.write(body.endsWith('\n') ? body : `${body}\n`);
  } catch (cause) {
    const code = (cause as { code?: string } | undefined)?.code;
    if (code === 'ENOENT') {
      process.stdout.write(`evaluation artifact not found on disk: ${relativePath}\n`);
      return;
    }
    process.stdout.write(
      `could not read evaluation artifact: ${cause instanceof Error ? cause.message : String(cause)}\n`
    );
  }
};

const unblockTaskAction = async (rawTaskId: string, opts: SprintOpt): Promise<void> => {
  const { deps, storage } = await bootstrapCli();
  const sprintId = await resolveSprintId(opts.sprint, storage.stateRoot);
  if (!sprintId.ok) {
    fail(sprintId.error.message);
    return;
  }
  const taskId = TaskId.parse(rawTaskId);
  if (!taskId.ok) {
    fail(`invalid task id: ${taskId.error.message}`);
    return;
  }
  if (sprintId.value.fromPin) process.stderr.write(pinFallbackNotice(sprintId.value.sprintId));
  const loaded = await deps.taskRepo.findById(sprintId.value.sprintId, taskId.value);
  if (!loaded.ok) {
    fail(loaded.error.message);
    return;
  }
  const result = await unblockTaskUseCase({
    task: loaded.value,
    sprintId: sprintId.value.sprintId,
    taskRepo: deps.taskRepo,
    sprintRepo: deps.sprintRepo,
    clock: deps.clock,
    logger: deps.logger,
  });
  if (!result.ok) {
    fail(result.error.message);
    return;
  }
  process.stdout.write(`unblocked task '${result.value.name}' (${String(result.value.id)})\n`);
};

/**
 * Register the `task` command group. Read-side plus a single recovery hatch (`unblock`) —
 * task creation is owned by the planning chain (AI generates the task graph from approved
 * tickets); manual `task add` / `task edit` are deferred until there's a concrete UX for
 * tweaking AI-generated plans.
 *
 *   ralphctl task list [--sprint <id>]
 *   ralphctl task show [--sprint <id>] <task-id>
 *   ralphctl task evaluation [--sprint <id>] <task-id>
 *   ralphctl task unblock [--sprint <id>] <task-id>
 *
 * `--sprint` defaults to the pinned current sprint (`ralphctl sprint set-current <id>` or any
 * TUI sprint pick); the fallback path prints a one-line stderr notice naming the substituted
 * sprint so a stale pin never silently targets the wrong one.
 *
 * `unblock` calls `unblockTaskUseCase` directly (not a registered flow) — there's no competing
 * flow surface to route through, unlike `sprint close` which now shares `close-sprint`'s flow
 * with the TUI.
 */
export const registerTaskCommand = (program: Command): void => {
  const task = program.command('task').description('inspect tasks for a sprint (planning generates them)');

  task
    .command('list')
    .description('list every task on the sprint, in order')
    .option(SPRINT_OPTION_FLAGS, SPRINT_OPTION_DESC)
    .action(listTasksAction);

  task
    .command('show <taskId>')
    .description('print a single task as JSON')
    .option(SPRINT_OPTION_FLAGS, SPRINT_OPTION_DESC)
    .action(showTaskAction);

  task
    .command('evaluation <taskId>')
    .description("print the latest evaluator verdict (evaluation.md) for the task's most recent evaluated attempt")
    .option(SPRINT_OPTION_FLAGS, SPRINT_OPTION_DESC)
    .action(evaluationTaskAction);

  task
    .command('unblock <taskId>')
    .description('flip a blocked task back to todo so the implement loop picks it up again')
    .option(SPRINT_OPTION_FLAGS, SPRINT_OPTION_DESC)
    .action(unblockTaskAction);
};

const formatTaskLine = (t: Task): string => {
  const orderStr = String(t.order).padStart(3, ' ');
  return `${orderStr}.  ${String(t.id)}  [${t.status.padEnd(8)}]  ${t.name}`;
};
