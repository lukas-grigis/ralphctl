/** What the evaluation overlay needs to open, captured by whichever view owns the cursor. */

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
   * Workspace-relative artifact path off `Attempt.evaluation.file`. Absent for a legacy `tasks.json` row that never
   * recorded one — the overlay's `unrecorded` arm.
   */
  readonly file?: string;
  /** ISO timestamp the attempt finished, when terminal. */
  readonly finishedAt?: string;
}
