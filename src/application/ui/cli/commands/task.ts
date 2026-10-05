import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { Option, type Command } from 'commander';
import type { BlockCause, QuarantinedDiff, Task } from '@src/domain/entity/task.ts';
import {
  recommendedPriorWork,
  type PriorWorkChoice,
  type PriorWorkDecision,
} from '@src/domain/entity/task-prior-work.ts';
import { quarantineStashMessage } from '@src/domain/value/quarantine-stash-message.ts';
import { formatDiffStat } from '@src/domain/value/diff-stat.ts';
import { probeTaskQuarantine, type QuarantineProbe } from '@src/application/ui/shared/prior-work.ts';
import { TaskId } from '@src/domain/value/id/task-id.ts';
import { bootstrapCli } from '@src/application/ui/cli/bootstrap.ts';
import { fail } from '@src/application/ui/cli/report-cli-error.ts';
import {
  resolveSprintAndIdForCli,
  resolveSprintForCli,
  SPRINT_OPTION_DESC,
  SPRINT_OPTION_FLAGS,
  type SprintOpt,
} from '@src/application/ui/cli/resolve-sprint-selection.ts';
import { unblockTaskUseCase } from '@src/business/task/unblock-task.ts';
import { evaluationArtifactSprintPath, latestRecordedEvaluation } from '@src/business/task/evaluation-artifact.ts';
import { DISPLAY_TEXT_MAX_CHARS, sanitizeDisplayText } from '@src/domain/value/display-text.ts';
import { resolveSprintDir } from '@src/integration/persistence/storage.ts';
import { messageOf } from '@src/domain/value/error/error-message.ts';

const listTasksAction = async (opts: SprintOpt): Promise<void> => {
  const { deps, storage } = await bootstrapCli();
  const sprintId = await resolveSprintForCli(opts.sprint, storage.stateRoot);
  if (sprintId === undefined) return;
  const result = await deps.taskRepo.findBySprintId(sprintId);
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
  const ids = await resolveSprintAndIdForCli(opts.sprint, storage.stateRoot, rawTaskId, TaskId.parse, 'task');
  if (ids === undefined) return;
  const { sprintId, id: taskId } = ids;
  const result = await deps.taskRepo.findById(sprintId, taskId);
  if (!result.ok) {
    fail(result.error.message);
    return;
  }
  process.stdout.write(`${JSON.stringify(result.value, null, 2)}\n`);
};

/**
 * Print the latest `evaluation.md` for a task — the evaluator's operator-readable verdict, which before this command
 * was written to disk every round and readable by nothing.
 */
const evaluationTaskAction = async (rawTaskId: string, opts: SprintOpt): Promise<void> => {
  const { deps, storage } = await bootstrapCli();
  const ids = await resolveSprintAndIdForCli(opts.sprint, storage.stateRoot, rawTaskId, TaskId.parse, 'task');
  if (ids === undefined) return;
  const { sprintId, id: taskId } = ids;
  const loaded = await deps.taskRepo.findById(sprintId, taskId);
  if (!loaded.ok) {
    fail(loaded.error.message);
    return;
  }

  const latest = latestRecordedEvaluation(loaded.value);
  if (latest === undefined) {
    process.stdout.write(`no evaluation recorded for task ${String(taskId)}\n`);
    return;
  }
  const relativePath = evaluationArtifactSprintPath(String(taskId), latest.file);
  if (relativePath === undefined) {
    process.stdout.write(`no evaluation artifact recorded for attempt ${String(latest.attemptN)} (legacy record)\n`);
    return;
  }
  // Tolerant resolver so both `<id>--<slug>/` and the legacy bare `<id>/` sprint dirs are found.
  const sprintDirPath = await resolveSprintDir(storage.dataRoot, sprintId);
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
    fail(`could not read evaluation artifact: ${messageOf(cause)}`);
  }
};

interface UnblockOpts extends SprintOpt {
  readonly priorWork?: PriorWorkChoice;
}

/** What `--prior-work` has to say about the stash, resolved before anything is written. */
interface PriorWorkPlan {
  readonly probe: QuarantineProbe;
  readonly decision?: PriorWorkDecision;
  /** True when the choice came from the cause-aware default rather than the flag. */
  readonly defaulted: boolean;
}

const CAUSE_PHRASE: Partial<Record<BlockCause, string>> = {
  'budget-exhausted': 'an attempt-budget block',
  'generator-self-block': 'a self-block',
  'operator-cancelled': 'an operator cancel',
  'post-verify-regression': 'a post-verify regression',
};

const defaultReason = (task: Task): string =>
  task.status === 'in_progress'
    ? 'an interrupted run'
    : task.status === 'blocked'
      ? (CAUSE_PHRASE[task.blockCause ?? 'unknown'] ?? 'an unclassified block')
      : 'the last block';

/** Probe the stash and decide what to record. A `todo` task is only probed when the flag asks to change its mind. */
const planPriorWork = async (
  deps: Awaited<ReturnType<typeof bootstrapCli>>['deps'],
  sprintId: Parameters<typeof quarantineStashMessage>[0],
  task: Task,
  flag: PriorWorkChoice | undefined
): Promise<PriorWorkPlan> => {
  if (task.status === 'todo' && flag === undefined) return { probe: { kind: 'none' }, defaulted: true };
  const sprint = await deps.sprintRepo.findById(sprintId);
  const project = sprint.ok ? await deps.projectRepo.findById(sprint.value.projectId) : undefined;
  const probe = await probeTaskQuarantine(deps, project?.ok === true ? project.value : undefined, sprintId, task);
  const choice = flag ?? recommendedPriorWork(task);
  if (probe.kind === 'present') {
    return {
      probe,
      defaulted: flag === undefined,
      decision: { choice, stashMessage: probe.stashMessage, stat: probe.stat, entries: probe.entries },
    };
  }
  // The stash key is deterministic, so an explicit choice is still recorded when git could not be read.
  if (probe.kind === 'unknown' && flag !== undefined) {
    return { probe, defaulted: false, decision: { choice, stashMessage: quarantineStashMessage(sprintId, task.id) } };
  }
  return { probe, defaulted: flag === undefined };
};

const STARTS_FRESH = 'starts fresh';
const CONTINUES = 'continues from the rejected diff';

const describeChoice = (fact: QuarantinedDiff | undefined): string =>
  fact?.nextAttempt === 'fresh'
    ? STARTS_FRESH
    : fact?.nextAttempt === 'continue'
      ? CONTINUES
      : 'restores the rejected diff (no choice recorded)';

const unblockTaskAction = async (rawTaskId: string, opts: UnblockOpts): Promise<void> => {
  const { deps, storage } = await bootstrapCli();
  const ids = await resolveSprintAndIdForCli(opts.sprint, storage.stateRoot, rawTaskId, TaskId.parse, 'task');
  if (ids === undefined) return;
  const { sprintId, id: taskId } = ids;
  const loaded = await deps.taskRepo.findById(sprintId, taskId);
  if (!loaded.ok) {
    fail(loaded.error.message);
    return;
  }
  const plan = await planPriorWork(deps, sprintId, loaded.value, opts.priorWork);
  const result = await unblockTaskUseCase({
    task: loaded.value,
    sprintId: sprintId,
    taskRepo: deps.taskRepo,
    sprintRepo: deps.sprintRepo,
    clock: deps.clock,
    logger: deps.logger,
    ...(plan.decision !== undefined ? { priorWork: plan.decision } : {}),
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
  const sprintRef = String(sprintId);
  writePriorWorkReport(plan, loaded.value, opts.priorWork, sprintRef, taskRef);
  const retry = `ralphctl task unblock --sprint ${sprintRef} ${taskRef}`;
  // A settled sprint coming back open changes what the operator can do with it (a closed one holds the project
  // again), so it is reported, never left to a log line the CLI doesn't render.
  const reopened = result.value.sprintReopened;
  if (reopened !== undefined) {
    // A retried review → active hop that failed again reports `from === status`: nothing moved,
    // so "reopened … review → review" would misstate it.
    const moved = reopened.from !== reopened.sprint.status;
    process.stdout.write(
      moved
        ? `reopened sprint '${reopened.sprint.slug}' (${sprintRef}) ${reopened.from} → ${reopened.sprint.status}\n`
        : `sprint '${reopened.sprint.slug}' (${sprintRef}) is still ${reopened.sprint.status}\n`
    );
    if (reopened.sprint.status !== 'active') {
      process.stderr.write(`note: the review → active step did not persist — run '${retry}' again to finish it\n`);
    }
  }
  // The reopen is best-effort, so an unblock that revived the task but left the sprint closed still exits 0 — it must
  // not also report as if the sprint had reopened.
  const conflict = result.value.sprintReopenConflict;
  if (conflict !== undefined) {
    process.stderr.write(`note: ${conflict.message}\n`);
    if (conflict.hint !== undefined) process.stderr.write(`      ${conflict.hint}\n`);
    process.stderr.write(
      `      then 'ralphctl sprint reopen ${sprintRef}' and '${retry}' to make this task runnable\n`
    );
  }
};

/** The prior-work lines under `unblocked task …`: stdout for what was recorded, stderr for what couldn't be. */
const writePriorWorkReport = (
  plan: PriorWorkPlan,
  before: Task,
  flag: PriorWorkChoice | undefined,
  sprintRef: string,
  taskRef: string
): void => {
  const { probe } = plan;
  if (probe.kind === 'unknown') {
    process.stderr.write(
      flag !== undefined
        ? `note: couldn't read git stash (${probe.error}) — recorded --prior-work ${flag} anyway\n`
        : `note: couldn't read git stash (${probe.error}); a rejected diff there would be restored on the next attempt\n`
    );
    return;
  }
  if (probe.kind === 'none') {
    if (flag !== undefined) {
      process.stderr.write(
        'note: no rejected diff in git stash for this task — --prior-work has nothing to apply to\n'
      );
    }
    return;
  }
  const choice = plan.decision?.choice ?? 'fresh';
  process.stdout.write(`rejected diff in git stash: ${probe.stashMessage} — ${formatDiffStat(probe.stat)}\n`);
  if (before.status === 'todo') {
    const now = choice === 'fresh' ? STARTS_FRESH : CONTINUES;
    process.stdout.write(`next attempt: ${now} (was: ${describeChoice(before.quarantinedDiff)})\n`);
    return;
  }
  const how = plan.defaulted ? `default after ${defaultReason(before)}` : `--prior-work ${choice}`;
  const other: PriorWorkChoice = choice === 'fresh' ? 'continue' : 'fresh';
  const effect =
    choice === 'fresh'
      ? `${STARTS_FRESH} (${how}); the diff stays in the stash`
      : `${CONTINUES} (${how}); it is restored before the first AI turn`;
  process.stdout.write(`next attempt: ${effect}\n`);
  if (plan.defaulted) {
    const verb = other === 'continue' ? 'to continue from it instead' : 'to start fresh instead';
    process.stdout.write(
      `      ${verb}: ralphctl task unblock --sprint ${sprintRef} ${taskRef} --prior-work ${other}\n`
    );
  }
};

/** Register the `task` command group. */
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
    .addOption(
      new Option(
        '--prior-work <choice>',
        'what the next attempt does with its quarantined rejected diff (default depends on why it stopped)'
      ).choices(['continue', 'fresh'])
    )
    .action(unblockTaskAction);
};

/** `task list`'s one line per task. */
const formatTaskLine = (t: Task): string => {
  const orderStr = String(t.order).padStart(3, ' ');
  const show = (text: string): string => sanitizeDisplayText(text, DISPLAY_TEXT_MAX_CHARS);
  const head = `${orderStr}.  ${String(t.id)}  [${t.status.padEnd(8)}]  ${show(t.name)}`;
  const fact = t.quarantinedDiff;
  if (t.status === 'todo' && fact !== undefined) {
    const next =
      fact.nextAttempt === 'fresh'
        ? 'starts fresh — rejected diff stays in git stash'
        : fact.nextAttempt === 'continue'
          ? 'continues from the rejected diff'
          : 'restores the rejected diff in git stash (no choice recorded)';
    return `${head}\n       next attempt: ${next}`;
  }
  if (t.status !== 'blocked') return head;
  const reasonFirstLine = t.blockedReason.split('\n')[0] ?? t.blockedReason;
  const lines = [head, `       ${show(reasonFirstLine)}`];
  if (t.blockerClass !== undefined) lines.push(`       blocker: ${t.blockerClass}`);
  if (t.question !== undefined) lines.push(`       question: ${show(t.question)}`);
  if (t.whatUnblocksMe !== undefined) lines.push(`       unblocks with: ${show(t.whatUnblocksMe)}`);
  if (fact !== undefined) {
    const stat = fact.stat !== undefined ? ` (${formatDiffStat(fact.stat)})` : '';
    lines.push(`       stash: ${fact.stashMessage}${stat}`);
  }
  const flagHint = fact !== undefined ? ' [--prior-work continue|fresh]' : '';
  lines.push(`       recover with: ralphctl task unblock ${String(t.id)}${flagHint}`);
  return lines.join('\n');
};
