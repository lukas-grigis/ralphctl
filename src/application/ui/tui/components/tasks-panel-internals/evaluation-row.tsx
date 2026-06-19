/**
 * Per-task evaluation verdict line for the Tasks panel.
 *
 * Renders the AUTHORITATIVE verdict for a task — sourced from the task entity's last attempt
 * (`Attempt.evaluation.status`, keyed by task id), NOT from the live bucketed signal stream.
 * The bucketed stream attributes evaluator signals to tasks by timestamp window, which is
 * unreliable under parallel/wave sprints (windows overlap, AI-fabricated timestamps), so a
 * `failed` signal from another lane could leak onto a passed task's card.
 *
 * Per-criterion attribution is deliberately NOT rendered: there is no per-criterion verdict in
 * the data. `EvaluationSignal` carries only an overall `status` + free-form `dimensions[]`, and
 * the persisted `Evaluation` carries only `status` + `file`. Positionally pairing the task's
 * acceptance criteria onto the evaluator's dimensions (the old `fuseCriteriaWithDimensions`)
 * fabricated attribution that the data never recorded — so it is gone. The acceptance criteria
 * still render, un-marked, as the "definition of done" via `CriteriaBlock`.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { EvaluationStatus } from '@src/domain/entity/task.ts';
import { inkColors } from '@src/application/ui/tui/theme/tokens.ts';
import { fmtIsoTime } from '@src/application/ui/tui/theme/duration.ts';

/**
 * Authoritative per-task verdict for the card — keyed by task id (built from the task entity's
 * attempts by the host), so it never leaks across lanes or stale rounds. The card renders THIS,
 * never the timestamp-bucketed signal stream.
 */
export interface TaskEvaluation {
  readonly status: EvaluationStatus;
  /** 1-indexed attempt the verdict belongs to. */
  readonly attemptN: number;
  /** ISO timestamp the attempt finished, when terminal. */
  readonly finishedAt?: string;
}

const statusColor = (status: EvaluationStatus): string =>
  status === 'passed' ? inkColors.success : status === 'failed' ? inkColors.error : inkColors.warning;

/**
 * One-line authoritative verdict: optional time/attempt prefix + `eval` + status, coloured by
 * status (passed → success, failed → error, malformed → warning). No per-criterion glyphs and
 * no signal-sourced dimension rows — see the module docstring.
 */
export const EvaluationLine = ({ evaluation }: { readonly evaluation: TaskEvaluation }): React.JSX.Element => {
  const { status, attemptN, finishedAt } = evaluation;
  return (
    <Box>
      {finishedAt !== undefined && <Text dimColor>{fmtIsoTime(finishedAt)}</Text>}
      <Text color={statusColor(status)} bold>
        {finishedAt !== undefined ? '  ' : ''}eval{'  '}
      </Text>
      <Text bold>{status}</Text>
      <Text dimColor> · attempt {String(attemptN)}</Text>
    </Box>
  );
};
