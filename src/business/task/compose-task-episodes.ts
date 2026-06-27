import type { BlockedTask, DoneTask, Task } from '@src/domain/entity/task.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { TaskEpisode } from '@src/domain/repository/episode/episode-types.ts';

/** Per-line clamp for a blocked task's reason rendered into the episode's one-line learning. */
const BLOCK_REASON_MAX_CHARS = 120;

/**
 * Deterministic sentinel for an attempt-less task (an upstream cascade-blocked task that never
 * ran). The episode `timestamp` is metadata only — {@link import('./episode-summary.ts')
 * summariseEpisodes} renders goal / outcome / keyLearnings and never the timestamp — so a task
 * that carries no real attempt timestamp gets this fixed value rather than a fabricated clock
 * read. Keeps the function pure (no `Date.now()`) and the field a valid ISO-8601 string.
 */
const EPOCH_SENTINEL = '1970-01-01T00:00:00.000Z' as IsoTimestamp;

/** Collapse whitespace and clamp a blocked task's reason to a single bounded line. */
const clampReason = (raw: string): string => {
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  return oneLine.length > BLOCK_REASON_MAX_CHARS ? `${oneLine.slice(0, BLOCK_REASON_MAX_CHARS - 1)}…` : oneLine;
};

/** The goal line — the task's description when present and non-empty, else its display name. */
const episodeGoal = (task: Task): string =>
  task.description !== undefined && task.description.trim().length > 0 ? task.description : task.name;

/**
 * Real timestamp for the episode, derived from the task's last attempt: prefer its terminal
 * `finishedAt`, fall back to `startedAt` for a still-running attempt, and finally to the epoch
 * sentinel for an attempt-less (upstream cascade-blocked) task. Never fabricates a clock read.
 */
const lastAttemptTimestamp = (task: DoneTask | BlockedTask): IsoTimestamp => {
  const last = task.attempts.at(-1);
  if (last === undefined) return EPOCH_SENTINEL;
  return last.finishedAt ?? last.startedAt;
};

/** Map a settled `done` task to a success episode with an honest attempt-count learning. */
const doneEpisode = (task: DoneTask, sprintId: SprintId): TaskEpisode => {
  const n = task.attempts.length;
  const base = `verified after ${String(n)} ${n === 1 ? 'attempt' : 'attempts'}`;
  const warning = task.attempts.at(-1)?.warning;
  return {
    taskId: String(task.id),
    sprintId: String(sprintId),
    goal: episodeGoal(task),
    outcome: 'success',
    keyLearnings: warning !== undefined ? `${base} (done-with-warning: ${warning.kind})` : base,
    timestamp: lastAttemptTimestamp(task),
  };
};

/**
 * Map a `blocked` task to an episode. An upstream cascade-block (`blockKind: 'upstream'`) means a
 * prerequisite failed, so the task was effectively abandoned rather than judged on its own merits;
 * an own-failure block stays `blocked`. The reason carries the honest learning.
 */
const blockedEpisode = (task: BlockedTask, sprintId: SprintId): TaskEpisode => ({
  taskId: String(task.id),
  sprintId: String(sprintId),
  goal: episodeGoal(task),
  outcome: task.blockKind === 'upstream' ? 'abandoned' : 'blocked',
  keyLearnings: clampReason(task.blockedReason),
  timestamp: lastAttemptTimestamp(task),
});

/**
 * Derive the sprint's episodic memory from the tasks already in hand — no new persistence. Only
 * SETTLED siblings (`done` / `blocked`) other than the current task contribute, so a later task in
 * the same sprint can orient on what an earlier task already solved or got blocked on. Input order
 * is preserved; downstream `summariseEpisodes` keeps the most recent tail.
 *
 * Pure: no I/O, no clock. All fields are derived from real entity data (see
 * {@link lastAttemptTimestamp} for the no-fabrication timestamp rule).
 *
 * @public
 */
export const composeTaskEpisodes = (
  tasks: readonly Task[],
  currentTaskId: TaskId,
  sprintId: SprintId
): readonly TaskEpisode[] => {
  const episodes: TaskEpisode[] = [];
  for (const task of tasks) {
    if (task.id === currentTaskId) continue;
    if (task.status === 'done') episodes.push(doneEpisode(task, sprintId));
    else if (task.status === 'blocked') episodes.push(blockedEpisode(task, sprintId));
  }
  return episodes;
};
