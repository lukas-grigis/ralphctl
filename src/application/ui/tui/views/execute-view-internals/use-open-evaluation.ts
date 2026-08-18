/**
 * The Execute view's `v` chord — turn the Tasks panel's focused card id into an
 * {@link EvaluationTarget} and hand it to the evaluation overlay, plus the boolean that gates the
 * footer hint.
 *
 * The panel knows WHICH card is focused; only the view holds the polled task entities and the
 * run's pinned sprint, which is where the verdict and its artifact path live. Splitting the two
 * that way keeps the panel free of repository knowledge and keeps the overlay free of async
 * lookups — the target it receives is already complete, including for the degrade cases.
 *
 * Every miss is a silent no-op (no pinned sprint, task not in the current poll, no attempt with a
 * verdict): `v` is an inspection chord, and opening an overlay onto nothing would be worse than
 * doing nothing. The panel already gates on `taskEvaluationById`, so this is belt-and-braces
 * against a poll that lands between the keystroke and the lookup.
 */

import { useCallback, useMemo } from 'react';
import { latestRecordedEvaluation } from '@src/business/task/evaluation-artifact.ts';
import type { EvaluationTarget } from '@src/application/ui/tui/runtime/evaluation-target.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { Task } from '@src/domain/entity/task.ts';

interface UseEvaluationChordArgs {
  readonly sprintId: SprintId | undefined;
  readonly taskState: readonly Task[] | undefined;
  readonly openEvaluation: (target: EvaluationTarget) => void;
}

export interface EvaluationChord {
  /** Handler threaded to `TasksPanelHost.onOpenEvaluation`. */
  readonly open: (taskId: string) => void;
  /** `true` when any polled task has a recorded verdict — the gate for the footer's `v` hint. */
  readonly hasAny: boolean;
}

export const useEvaluationChord = ({
  sprintId,
  taskState,
  openEvaluation,
}: UseEvaluationChordArgs): EvaluationChord => {
  const open = useCallback(
    (taskId: string): void => {
      if (sprintId === undefined || taskState === undefined) return;
      const task = taskState.find((t) => String(t.id) === taskId);
      if (task === undefined) return;
      const latest = latestRecordedEvaluation(task);
      if (latest === undefined) return;
      openEvaluation({
        sprintId,
        taskId,
        taskLabel: task.name,
        attemptN: latest.attemptN,
        status: latest.status,
        ...(latest.file.length > 0 ? { file: latest.file } : {}),
        ...(latest.finishedAt !== undefined ? { finishedAt: latest.finishedAt } : {}),
      });
    },
    [sprintId, taskState, openEvaluation]
  );

  const hasAny = useMemo(
    () => taskState !== undefined && taskState.some((t) => latestRecordedEvaluation(t) !== undefined),
    [taskState]
  );

  return { open, hasAny };
};
