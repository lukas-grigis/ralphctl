/**
 * Locating an attempt's `evaluation.md` artifact — the two pure steps every reader of that file
 * shares (the TUI evaluation overlay and `ralphctl task evaluation`).
 *
 * The evaluator re-stamps `Attempt.evaluation` on EVERY evaluator turn, so a settled attempt's
 * recorded path always points at that attempt's LAST round. There is no history to walk.
 */

import { isAbsolute, normalize } from 'node:path';
import type { EvaluationStatus, Task } from '@src/domain/entity/task.ts';

/** The attempt-scoped verdict an operator surface renders, flattened off `Attempt`. */
export interface LatestEvaluation {
  /** 1-indexed attempt the verdict belongs to. */
  readonly attemptN: number;
  readonly status: EvaluationStatus;
  /**
   * Workspace-relative path of the rendered verdict file, e.g. `rounds/3/evaluator/evaluation.md`.
   * Legacy `tasks.json` rows can carry an empty string here — the reader degrades, never errors.
   */
  readonly file: string;
  /** ISO timestamp the attempt finished, when terminal. */
  readonly finishedAt?: string;
}

/**
 * The most recent attempt carrying an evaluation, walking backwards from the last. Prefers the
 * final attempt; falls back to the most recent one that recorded a verdict (a crashed / aborted
 * final attempt never reaches the evaluator, and the operator still wants the prior verdict).
 * `undefined` when no attempt on the task has one.
 */
export const latestRecordedEvaluation = (task: Task): LatestEvaluation | undefined => {
  for (let i = task.attempts.length - 1; i >= 0; i -= 1) {
    const attempt = task.attempts[i];
    if (attempt?.evaluation === undefined) continue;
    return {
      attemptN: attempt.n,
      status: attempt.evaluation.status,
      file: attempt.evaluation.file,
      ...(attempt.finishedAt !== null ? { finishedAt: attempt.finishedAt } : {}),
    };
  }
  return undefined;
};

/**
 * Path of the artifact RELATIVE TO THE SPRINT DIRECTORY, or `undefined` when the recorded path is
 * absent or untrustworthy. The per-task workspace root is `<sprintDir>/implement/<taskId>` (see
 * `flows/implement/leaves/build-task-workspace.ts`) and `Evaluation.file` is relative to it.
 *
 * A `tasks.json` row is untrusted input — it can be hand-edited, restored from a backup, or
 * written by a future version. An absolute path or one that climbs out of the workspace (`..`) is
 * refused rather than followed: callers treat `undefined` exactly like an unrecorded artifact, so
 * the degrade path is the same one legacy rows already take.
 */
export const evaluationArtifactSprintPath = (taskId: string, file: string): string | undefined => {
  const trimmed = file.trim();
  if (trimmed.length === 0 || isAbsolute(trimmed)) return undefined;
  const normalized = normalize(trimmed);
  if (normalized === '..' || normalized.startsWith(`..${'/'}`) || normalized.startsWith(`..${'\\'}`)) return undefined;
  return `implement/${taskId}/${normalized}`;
};
