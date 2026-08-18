/**
 * What the evaluation overlay needs to open, captured by whichever view owns the cursor.
 *
 * Deliberately a complete snapshot rather than a pair of ids: the two opening surfaces (the
 * Execute Tasks panel and sprint-detail) already hold the task entity, and the overlay's DEGRADE
 * arms — legacy row with no recorded artifact, pruned workspace, unreadable file — must still
 * render today's one-line verdict. Re-querying the repository from inside the overlay would make
 * those arms depend on a second async read that can fail on its own.
 */

import type { EvaluationStatus } from '@src/domain/entity/task.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';

export interface EvaluationTarget {
  readonly sprintId: SprintId;
  readonly taskId: string;
  /** Friendly task name for the overlay header; falls back to the id at the call site. */
  readonly taskLabel: string;
  /** 1-indexed attempt the verdict belongs to. */
  readonly attemptN: number;
  readonly status: EvaluationStatus;
  /**
   * Workspace-relative artifact path off `Attempt.evaluation.file`. Absent for a legacy
   * `tasks.json` row that never recorded one — the overlay's `unrecorded` arm.
   */
  readonly file?: string;
  /** ISO timestamp the attempt finished, when terminal. */
  readonly finishedAt?: string;
}
