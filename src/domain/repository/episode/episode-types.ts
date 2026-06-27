import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';

/**
 * A single episodic record capturing the outcome of one completed task execution. Episodes
 * are stored per-sprint and injected as a summary into the implement prompt so subsequent
 * tasks within the same sprint (and later, across sprints) can learn from prior outcomes
 * without re-discovering what worked or what didn't.
 *
 * Rationale: injecting a compact history of prior task outcomes lets a later task avoid
 * re-discovering what an earlier task in the same sprint already solved or got blocked on.
 *
 * @public
 */
export type TaskEpisode = {
  readonly taskId: string;
  readonly sprintId: string;
  /** The task's description / goal — one-liner or short paragraph. */
  readonly goal: string;
  readonly outcome: 'success' | 'partial' | 'blocked' | 'abandoned';
  /** One-line summary of what worked or what didn't on this task. */
  readonly keyLearnings: string;
  readonly timestamp: IsoTimestamp;
};
