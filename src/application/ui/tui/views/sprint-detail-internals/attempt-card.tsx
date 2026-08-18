/**
 * Per-attempt sub-card rendered inside the expanded task detail body.
 *
 * Shows the attempt number, status chip, started / finished timestamps, elapsed, session id,
 * commit sha, evaluation outcome, any warning, and the leading line of the evaluator critique.
 * The `v to open` chord hint is gated on `openableAttemptN` — the chord is task-scoped, so only
 * the attempt it actually resolves to may advertise it.
 * Lifted out of `task-summary.tsx` so the tasks list file stays under 350 LOC and the
 * attempt-specific helpers (`attemptStatusKind`, `evaluationColor`, `renderWarningDetail`) live
 * next to their sole call site.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { StatusChip, type StatusKind } from '@src/application/ui/tui/components/status-chip.tsx';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { fmtDuration, fmtIsoAbsolute } from '@src/application/ui/tui/theme/duration.ts';
import type { Attempt } from '@src/domain/entity/attempt.ts';

export const attemptElapsedMs = (attempt: Attempt): number | undefined => {
  if (attempt.status === 'running' || attempt.finishedAt === null) return undefined;
  const finished = Date.parse(attempt.finishedAt);
  const started = Date.parse(attempt.startedAt);
  return Number.isFinite(finished) && Number.isFinite(started) ? finished - started : undefined;
};

export const AttemptCard = ({
  attempt,
  openableAttemptN,
}: {
  readonly attempt: Attempt;
  /**
   * Attempt number the task-scoped `v` chord actually resolves to
   * (`latestRecordedEvaluation(task)?.attemptN`), or `undefined` when the task has no verdict at
   * all. Only that attempt's card advertises the chord — every other card would name a file `v`
   * does not open.
   */
  readonly openableAttemptN: number | undefined;
}): React.JSX.Element => {
  const elapsedMs = attemptElapsedMs(attempt);
  return (
    <Box flexDirection="column" marginBottom={spacing.section} paddingLeft={spacing.gutter}>
      <Box>
        <Text bold>#{String(attempt.n)}</Text>
        <Text> </Text>
        <StatusChip label={attempt.status} kind={attemptStatusKind(attempt.status)} />
        <Text dimColor>
          {' '}
          {glyphs.bullet} started {fmtIsoAbsolute(attempt.startedAt)}
        </Text>
        {attempt.finishedAt !== null && (
          <Text dimColor>
            {' '}
            {glyphs.bullet} finished {fmtIsoAbsolute(attempt.finishedAt)}
          </Text>
        )}
        {elapsedMs !== undefined && (
          <Text dimColor>
            {' '}
            {glyphs.bullet} elapsed {fmtDuration(elapsedMs)}
          </Text>
        )}
      </Box>
      <Box paddingLeft={spacing.indent} flexDirection="column">
        {attempt.sessionId !== undefined && (
          <Text dimColor>
            session: <Text>{attempt.sessionId}</Text>
          </Text>
        )}
        {attempt.commitSha !== undefined && (
          <Text dimColor>
            commit: <Text>{String(attempt.commitSha)}</Text>
          </Text>
        )}
        {attempt.evaluation !== undefined && (
          <Text dimColor>
            evaluation: <Text color={evaluationColor(attempt.evaluation.status)}>{attempt.evaluation.status}</Text>{' '}
            <Text dimColor>({attempt.evaluation.file})</Text>
            {attempt.n === openableAttemptN && <Text dimColor> {glyphs.bullet} v to open</Text>}
          </Text>
        )}
        {attempt.warning !== undefined && (
          <Text color={inkColors.warning}>
            {glyphs.warningGlyph} {attempt.warning.kind}
            {renderWarningDetail(attempt.warning)}
          </Text>
        )}
        {attempt.critique !== undefined && (
          <Box paddingLeft={spacing.gutter}>
            <Text dimColor italic>
              critique: {firstLine(attempt.critique)}
            </Text>
          </Box>
        )}
      </Box>
    </Box>
  );
};

const attemptStatusKind = (status: Attempt['status']): StatusKind => {
  switch (status) {
    case 'running':
      return 'info';
    case 'verified':
      return 'success';
    case 'failed':
      return 'error';
    case 'malformed':
      return 'error';
    case 'aborted':
      return 'warning';
  }
};

const evaluationColor = (status: 'passed' | 'failed' | 'malformed'): string => {
  switch (status) {
    case 'passed':
      return inkColors.success;
    case 'failed':
      return inkColors.error;
    case 'malformed':
      return inkColors.warning;
  }
};

/**
 * Human-readable detail tail for an attempt warning. The base label (`budget-exhausted`,
 * `plateau`, …) is rendered by the caller; this returns the suffix (` · 5/5 turns`, etc.).
 */
const renderWarningDetail = (w: NonNullable<Attempt['warning']>): string => {
  switch (w.kind) {
    case 'budget-exhausted':
      return `  ${glyphs.bullet} ${String(w.turnsUsed)}/${String(w.turnBudget)} turns`;
    case 'plateau':
      return w.dimensions.length > 0 ? `  ${glyphs.bullet} ${w.dimensions.join(', ')}` : '';
    case 'malformed':
      return `  ${glyphs.bullet} ${firstLine(w.detail)}`;
    case 'verify-failed':
      return `  ${glyphs.bullet} exit ${String(w.exitCode ?? '?')}${w.stderr.length > 0 ? ` · ${firstLine(w.stderr)}` : ''}`;
    case 'crashed':
      return `  ${glyphs.bullet} ${firstLine(w.detail)}`;
  }
};

const firstLine = (s: string): string => {
  const line = s.split('\n').find((l) => l.trim().length > 0) ?? '';
  return line.length > 120 ? `${line.slice(0, 119)}${glyphs.clipEllipsis}` : line;
};
