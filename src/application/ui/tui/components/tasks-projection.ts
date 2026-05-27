import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { Attempt } from '@src/domain/entity/attempt.ts';
import type { Task } from '@src/domain/entity/task.ts';

/**
 * TUI-local minimal projection for the Tasks panel — the narrow slice the panel needs from a
 * Task entity to render ETAs + commit-sha chips. Wave 7 deleted the wider
 * `state-projection.ts` (audit-[07] — no more chain.log mining); this module replaces just
 * the per-task fields the live TUI was reading from that projection.
 *
 * Pure — no I/O. Same Task in, same projection out.
 */
export interface TaskProjection {
  readonly id: string;
  readonly attemptsCount: number;
  readonly lastAttempt?: {
    readonly commitSha?: string;
    readonly startedAt: IsoTimestamp;
    readonly finishedAt?: IsoTimestamp;
  };
  /** Median of every settled attempt's `finishedAt - startedAt`; undefined when no settled attempt has a duration. */
  readonly medianRoundDurationMs?: number;
}

export interface SprintState {
  readonly tasks: readonly TaskProjection[];
}

const medianSettledDurationMs = (attempts: readonly Attempt[]): number | undefined => {
  const durations: number[] = [];
  for (const att of attempts) {
    if (att.status === 'running') continue;
    durations.push(new Date(att.finishedAt).getTime() - new Date(att.startedAt).getTime());
  }
  if (durations.length === 0) return undefined;
  durations.sort((a, b) => a - b);
  const mid = Math.floor(durations.length / 2);
  if (durations.length % 2 === 1) return durations[mid];
  const lo = durations[mid - 1];
  const hi = durations[mid];
  return lo !== undefined && hi !== undefined ? (lo + hi) / 2 : undefined;
};

const summariseAttempt = (att: Attempt): TaskProjection['lastAttempt'] => {
  const finishedAt = att.status === 'running' ? undefined : att.finishedAt;
  return {
    ...(att.commitSha !== undefined ? { commitSha: String(att.commitSha) } : {}),
    startedAt: att.startedAt,
    ...(finishedAt !== undefined ? { finishedAt } : {}),
  };
};

/**
 * Project one task into the minimal {@link TaskProjection} the Tasks panel reads.
 *
 * @public
 */
export const projectTask = (task: Task): TaskProjection => {
  const last = task.attempts[task.attempts.length - 1];
  const lastAttempt = last !== undefined ? summariseAttempt(last) : undefined;
  const median = medianSettledDurationMs(task.attempts);
  return {
    id: String(task.id),
    attemptsCount: task.attempts.length,
    ...(lastAttempt !== undefined ? { lastAttempt } : {}),
    ...(median !== undefined ? { medianRoundDurationMs: median } : {}),
  };
};

/**
 * Project every task into the TUI sprint-state shape.
 *
 * @public
 */
export const projectTasksSprintState = (tasks: readonly Task[]): SprintState => ({
  tasks: tasks.map(projectTask),
});
