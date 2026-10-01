/** Per-task evaluation verdict line for the Tasks panel. */

import React from 'react';
import { Box, Text } from 'ink';
import type { EvaluationStatus } from '@src/domain/entity/task.ts';
import { inkColors } from '@src/application/ui/tui/theme/tokens.ts';
import { fmtIsoTime } from '@src/application/ui/tui/theme/duration.ts';

/**
 * Authoritative per-task verdict for the card — keyed by task id (built from the task entity's attempts by the host),
 * so it never leaks across lanes or stale rounds.
 */
export interface TaskEvaluation {
  readonly status: EvaluationStatus;
  /** 1-indexed attempt the verdict belongs to. */
  readonly attemptN: number;
  /** ISO timestamp the attempt finished, when terminal. */
  readonly finishedAt?: string;
  /** Workspace-relative path of the attempt's `evaluation.md`, when one was recorded. */
  readonly file?: string;
}

const statusColor = (status: EvaluationStatus): string =>
  status === 'passed' ? inkColors.success : status === 'failed' ? inkColors.error : inkColors.warning;

/**
 * One-line authoritative verdict: optional time/attempt prefix + `eval` + status, coloured by status (passed →
 * success, failed → error, malformed → warning).
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
