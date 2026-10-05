/**
 * The unblock-time question about a task's quarantined rejected diff: probe git for the stash, build the
 * question copy, ask it through the `InteractivePrompt` port. Pure copy + one best-effort git read; the
 * use case that records the answer never touches git.
 */

import { Result } from '@src/domain/result.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { QuarantinedDiff, Task } from '@src/domain/entity/task.ts';
import {
  recommendedPriorWork,
  type PriorWorkChoice,
  type PriorWorkDecision,
} from '@src/domain/entity/task-prior-work.ts';
import { quarantineStashMessage } from '@src/domain/value/quarantine-stash-message.ts';
import { formatDiffStat, type DiffStat } from '@src/domain/value/diff-stat.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { Choice, InteractivePrompt } from '@src/business/interactive/prompt.ts';
import { gitStashInspect, type StashFileStat } from '@src/integration/io/git-stash.ts';
import type { GitRunner } from '@src/integration/io/git-runner.ts';
import { glyphs } from '@src/application/ui/tui/theme/tokens.ts';

export type QuarantineProbe =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'present';
      readonly stashMessage: string;
      readonly entries: number;
      readonly stat: DiffStat;
      readonly files: readonly StashFileStat[];
    }
  | { readonly kind: 'unknown'; readonly error: string };

/** Most file rows the question lists before collapsing the rest. */
const MAX_FILE_ROWS = 40;

/** The repository checkout the task's stash lives in (worktrees share the repo's stash ref). */
export const repoPathForTask = (project: Project | undefined, task: Task): AbsolutePath | undefined =>
  project?.repositories.find((r) => r.id === task.repositoryId)?.path;

/** Look for the task's quarantined stash entry. Never returns an error — a failed read is `unknown`. */
export const probeQuarantinedDiff = async (
  deps: { readonly gitRunner: GitRunner },
  repoPath: AbsolutePath,
  sprintId: SprintId,
  task: Task
): Promise<QuarantineProbe> => {
  const stashMessage = quarantineStashMessage(sprintId, task.id);
  const inspected = await gitStashInspect(deps.gitRunner, repoPath, stashMessage);
  if (!inspected.ok) return { kind: 'unknown', error: inspected.error.message };
  const newest = inspected.value.newest;
  if (inspected.value.entries === 0 || newest === undefined) return { kind: 'none' };
  return { kind: 'present', stashMessage, entries: inspected.value.entries, stat: newest.stat, files: newest.files };
};

/** Probe a task that could hold a stash: a task with no resolvable repository has none to find. */
export const probeTaskQuarantine = async (
  deps: { readonly gitRunner: GitRunner },
  project: Project | undefined,
  sprintId: SprintId,
  task: Task
): Promise<QuarantineProbe> => {
  const repoPath = repoPathForTask(project, task);
  if (repoPath === undefined) return { kind: 'none' };
  return probeQuarantinedDiff(deps, repoPath, sprintId, task);
};

type PresentProbe = Extract<QuarantineProbe, { kind: 'present' }>;

const firstLine = (text: string): string => text.split('\n')[0]?.trim() ?? '';

/** Why the task stopped, in the words the suggestion line and the bulk rows share. */
const YOUR_CANCEL = 'your cancel';

const stoppedFor = (task: Task): string | undefined => {
  if (task.status === 'in_progress') return YOUR_CANCEL;
  if (task.status !== 'blocked') return undefined;
  if (task.blockCause === 'generator-self-block') return 'a missing answer';
  if (task.blockCause === 'operator-cancelled') return YOUR_CANCEL;
  return undefined;
};

const suggestionLine = (task: Task, recommended: PriorWorkChoice): string =>
  recommended === 'continue'
    ? `suggested: continue ${glyphs.emDash} it stopped for ${stoppedFor(task) ?? YOUR_CANCEL}, not on quality`
    : `suggested: start fresh ${glyphs.emDash} the diff failed review and its critique was archived`;

const fileRow = (f: StashFileStat): string =>
  f.binary === true
    ? `${'binary'.padStart(11)}  ${f.path}`
    : `${`+${String(f.insertions)}`.padStart(5)} ${`-${String(f.deletions)}`.padStart(5)}  ${f.path}`;

const questionBody = (task: Task, probe: PresentProbe, recommended: PriorWorkChoice): string[] => {
  const lines = [`kept in git stash: ${probe.stashMessage}`];
  const entries =
    probe.entries > 1
      ? ` ${glyphs.bullet} ${String(probe.entries)} stash entries under this name ${glyphs.emDash} the newest is shown`
      : '';
  const blocked = task.status === 'blocked' ? ` ${glyphs.bullet} blocked: ${firstLine(task.blockedReason)}` : '';
  lines.push(`${formatDiffStat(probe.stat)}${entries}${blocked}`, suggestionLine(task, recommended), '');
  for (const f of probe.files.slice(0, MAX_FILE_ROWS)) lines.push(fileRow(f));
  if (probe.files.length > MAX_FILE_ROWS) {
    lines.push(`${glyphs.clipEllipsis} and ${String(probe.files.length - MAX_FILE_ROWS)} more files`);
  }
  if (probe.stat.partial === true) lines.push("untracked files not counted — this git can't list them");
  return lines;
};

const FRESH: Choice<PriorWorkChoice> = {
  label: 'Start fresh',
  value: 'fresh',
  description: 'the diff stays in git stash; the next attempt starts from the sprint branch',
};
const CONTINUE: Choice<PriorWorkChoice> = {
  label: 'Continue from it',
  value: 'continue',
  description: "the diff is restored before the next attempt's first AI turn",
};

/** The single-task question: header, blank line, body; the recommended option is listed first. */
export const priorWorkQuestion = (
  task: Task,
  probe: PresentProbe,
  recommended: PriorWorkChoice
): { readonly message: string; readonly choices: ReadonlyArray<Choice<PriorWorkChoice>> } => {
  const header = `Unblock "${task.name}" ${glyphs.emDash} what should its next attempt do with the rejected diff?`;
  return {
    message: [header, '', ...questionBody(task, probe, recommended)].join('\n'),
    choices: recommended === 'continue' ? [CONTINUE, FRESH] : [FRESH, CONTINUE],
  };
};

/** The operator's answer as a decision, or `'cancelled'` when they pressed Esc. Thrown errors propagate. */
export const askPriorWork = async (
  interactive: InteractivePrompt,
  task: Task,
  probe: PresentProbe
): Promise<Result<PriorWorkDecision | 'cancelled', never>> => {
  const { message, choices } = priorWorkQuestion(task, probe, recommendedPriorWork(task));
  const answer = await interactive.askChoice(message, choices);
  // The prompt adapter reports Esc as an error Result; an abort of the run throws instead and is not caught here.
  if (!answer.ok) return Result.ok('cancelled');
  return Result.ok({
    choice: answer.value,
    stashMessage: probe.stashMessage,
    stat: probe.stat,
    entries: probe.entries,
  });
};

export interface BulkPriorWorkRow {
  readonly task: Task;
  readonly probe: QuarantineProbe;
}

const bulkRowLabel = (task: Task, probe: PresentProbe): string => {
  const why =
    stoppedFor(task) !== undefined
      ? `stopped for ${stoppedFor(task)}`
      : task.status === 'blocked'
        ? firstLine(task.blockedReason)
        : 'stopped mid-attempt';
  return `${task.name} ${glyphs.emDash} ${formatDiffStat(probe.stat)} ${glyphs.bullet} ${why}`;
};

/** Per-task decisions from one multi-choice; `'cancelled'` on Esc. Tasks without a stash are absent. */
export const askBulkPriorWork = async (
  interactive: InteractivePrompt,
  rows: readonly BulkPriorWorkRow[],
  totalStuck: number
): Promise<Result<ReadonlyMap<string, PriorWorkDecision> | 'cancelled', never>> => {
  const present = rows.flatMap((r) => (r.probe.kind === 'present' ? [{ task: r.task, probe: r.probe }] : []));
  if (present.length === 0) return Result.ok(new Map());
  const message =
    `Unblock ${String(totalStuck)} stuck task${totalStuck === 1 ? '' : 's'} ${glyphs.emDash} ${String(present.length)} left a rejected diff in git stash. ` +
    'Tick the ones whose next attempt\nshould continue from it; the rest start fresh and their diff stays in the stash.';
  const choices = present.map(({ task, probe }): Choice<string> => ({
    label: bulkRowLabel(task, probe),
    value: String(task.id),
  }));
  const initial = present
    .filter(({ task }) => recommendedPriorWork(task) === 'continue')
    .map(({ task }) => String(task.id));
  const answer = await interactive.askMultiChoice(message, choices, { initial });
  if (!answer.ok) return Result.ok('cancelled');
  const ticked = new Set(answer.value);
  return Result.ok(
    new Map(
      present.map(({ task, probe }): [string, PriorWorkDecision] => [
        String(task.id),
        {
          choice: ticked.has(String(task.id)) ? 'continue' : 'fresh',
          stashMessage: probe.stashMessage,
          stat: probe.stat,
          entries: probe.entries,
        },
      ])
    )
  );
};

/**
 * The toast clause saying what the next attempt does with the rejected diff, or `undefined` when
 * there was no stash to speak of. `warn` marks the probe-failed case, which must not read as a clean success.
 */
export const priorWorkClause = (
  probe: QuarantineProbe,
  fact: QuarantinedDiff | undefined
): { readonly text: string; readonly warn: boolean } | undefined => {
  if (probe.kind === 'unknown') {
    return {
      text: `couldn't read git stash (${probe.error}); a rejected diff there would be restored on the next attempt`,
      warn: true,
    };
  }
  if (probe.kind === 'none') return undefined;
  if (fact?.nextAttempt === 'continue') {
    return { text: `next attempt continues from its rejected diff (${formatDiffStat(probe.stat)})`, warn: false };
  }
  return { text: 'next attempt starts fresh; its rejected diff stays in git stash', warn: false };
};

/** The toast for an Esc at the prior-work question — nothing was written. */
export const unblockCancelledToast = (name: string): string =>
  `${glyphs.infoGlyph} unblock cancelled ${glyphs.emDash} "${name}" is still blocked`;
