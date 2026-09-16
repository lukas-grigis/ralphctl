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
import { DISPLAY_TEXT_MAX_CHARS, sanitizeDisplayText } from '@src/domain/value/display-text.ts';
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
  // Planner-authored name echoed back at the terminal — same neutering as the list rows.
  const taskRef = String(result.value.task.id);
  process.stdout.write(
    `unblocked task '${sanitizeDisplayText(result.value.task.name, DISPLAY_TEXT_MAX_CHARS)}' (${taskRef})\n`
  );
  const sprintRef = String(sprintId.value.sprintId);
  const retry = `ralphctl task unblock --sprint ${sprintRef} ${taskRef}`;
  // A settled sprint coming back open changes what the operator can do with it (a closed one
  // holds the project again), so it is reported, never left to a log line the CLI doesn't render.
  // Same wording as `sprint reopen`'s own confirmation.
  const reopened = result.value.sprintReopened;
  if (reopened !== undefined) {
    process.stdout.write(
      `reopened sprint '${reopened.sprint.slug}' (${sprintRef}) ${reopened.from} → ${reopened.sprint.status}\n`
    );
    if (reopened.sprint.status !== 'active') {
      process.stderr.write(`note: the review → active step did not persist — run '${retry}' again to finish it\n`);
    }
  }
  // The reopen is best-effort, so an unblock that revived the task but left the sprint closed
  // still exits 0 — it must not also report as if the sprint had reopened. The conflict message
  // names the peer holding the project and its hint names the command that releases it. Re-running
  // unblock on the now-`todo` task does not reopen a closed sprint, so the last line names the two
  // commands that do.
  const conflict = result.value.sprintReopenConflict;
  if (conflict !== undefined) {
    process.stderr.write(`note: ${conflict.message}\n`);
    if (conflict.hint !== undefined) process.stderr.write(`      ${conflict.hint}\n`);
    process.stderr.write(
      `      then 'ralphctl sprint reopen ${sprintRef}' and '${retry}' to make this task runnable\n`
    );
  }
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

/**
 * `task list`'s one line per task. A `blocked` entry gets extra indented lines: the first line of
 * `blockedReason` (the quarantine stash handle, when one was recorded, rides in that text — see
 * `record-quarantine.ts`); when the block came from a generator `task-blocked` signal that supplied
 * its own structured triage (`BlockedTask.blockerClass` / `.question` / `.whatUnblocksMe` — see
 * `domain/entity/task.ts`), the model's classification, the concrete question, and what would
 * unblock it; and a `recover with:` footer naming the exact unblock command — previously the
 * recovery hatch was discoverable only by reading `--help`. The three triage fields are all
 * optional (absent for non-self-block paths, and for a self-block whose signal omitted them), so
 * `ralphctl task list` degrades to the reason-only line whenever they weren't recorded.
 *
 * The task NAME, the reason, the question and `whatUnblocksMe` are all MODEL-authored prose off a
 * generator that just read the target repository, so each goes through {@link sanitizeDisplayText}
 * on the way to stdout: ANSI/OSC bytes in a prompt-injected answer would otherwise be executed by
 * the operator's terminal, and an unbounded field would flood the row. The clamp is per field, so a
 * long question cannot push the `recover with:` footer off the screen either. `blockerClass` is the
 * one value pushed out raw — a closed three-value enum the signal schema already validates, so
 * there is nothing to neuter. The name is sanitised on EVERY row, blocked or not: the planner
 * authors it for every task, so a `todo` row carries the same injection surface as a blocked one.
 */
const formatTaskLine = (t: Task): string => {
  const orderStr = String(t.order).padStart(3, ' ');
  const show = (text: string): string => sanitizeDisplayText(text, DISPLAY_TEXT_MAX_CHARS);
  const head = `${orderStr}.  ${String(t.id)}  [${t.status.padEnd(8)}]  ${show(t.name)}`;
  if (t.status !== 'blocked') return head;
  const reasonFirstLine = t.blockedReason.split('\n')[0] ?? t.blockedReason;
  const lines = [head, `       ${show(reasonFirstLine)}`];
  if (t.blockerClass !== undefined) lines.push(`       blocker: ${t.blockerClass}`);
  if (t.question !== undefined) lines.push(`       question: ${show(t.question)}`);
  if (t.whatUnblocksMe !== undefined) lines.push(`       unblocks with: ${show(t.whatUnblocksMe)}`);
  lines.push(`       recover with: ralphctl task unblock ${String(t.id)}`);
  return lines.join('\n');
};
