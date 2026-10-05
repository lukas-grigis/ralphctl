import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';

/**
 * Deterministic stash message for one quarantined block — the recovery handle the operator greps
 * for in `git stash list`. Stable across runs (no timestamp / positional ref), so a relaunch that
 * re-quarantines produces an identical message and `record-quarantine` stays idempotent.
 */
export const quarantineStashMessage = (sprintId: SprintId, taskId: TaskId): string =>
  `ralphctl/${String(sprintId)}/${String(taskId)}/blocked-diff`;
