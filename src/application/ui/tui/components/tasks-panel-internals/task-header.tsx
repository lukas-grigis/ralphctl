/**
 * Header cluster of a task card — the rows that render whether the card is collapsed or expanded (core line, summary
 * chips, attempt/round and ETA chips, notices). Each part returns `null` when it has nothing to show.
 */

import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { resolveAttemptCoords, type TaskBucket } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import { sanitizeDisplayText } from '@src/domain/value/display-text.ts';
import type { BlockedTriage, TaskProjection } from '@src/application/ui/tui/components/tasks-projection.ts';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { fmtDuration } from '@src/application/ui/tui/theme/duration.ts';
import { Spinner } from '@src/application/ui/tui/components/spinner.tsx';
import { collapseWhitespace, formatEtaChip } from '@src/application/ui/tui/components/tasks-panel-internals/format.ts';
import { STATUS_PRESENTATION } from '@src/application/ui/tui/components/tasks-panel-internals/task-card-parts.tsx';

/**
 * Cursor caret, status glyph/spinner, display name, duration, and status word — the header's fixed-position core,
 * rendered collapsed OR expanded.
 */
export const TaskHeaderCore = ({
  cardFocused,
  running,
  status,
  display,
  durationMs,
}: {
  readonly cardFocused: boolean;
  readonly running: boolean;
  readonly status: TaskBucket['status'];
  readonly display: string;
  readonly durationMs: number | undefined;
}): React.JSX.Element => {
  const presentation = STATUS_PRESENTATION[status];
  const isSpinning = status === 'running';
  return (
    <>
      <Text color={cardFocused ? inkColors.highlight : inkColors.muted} bold={cardFocused}>
        {cardFocused ? glyphs.selectMarker : ' '}{' '}
      </Text>
      {isSpinning ? (
        <Spinner active={running} color={presentation.color} />
      ) : (
        <Text color={presentation.color} bold>
          {presentation.glyph}
        </Text>
      )}
      <Text bold> {display}</Text>
      {durationMs !== undefined && (
        <Text dimColor>
          {' '}
          {glyphs.bullet} {fmtDuration(durationMs)}
        </Text>
      )}
      <Text dimColor>
        {' '}
        {glyphs.bullet} {status}
      </Text>
    </>
  );
};

/** Collapsed-header trailing chips (attempt count / latest commit SHA). Self-gates on `cardExpanded`. */
export const HeaderSummaryChips = ({
  cardExpanded,
  taskProjection,
}: {
  readonly cardExpanded: boolean;
  readonly taskProjection: TaskProjection | undefined;
}): React.JSX.Element | null => {
  // Most recent commit SHA for the collapsed summary line — sourced from the projection's lastAttempt when a
  // TaskProjection is supplied.
  const latestCommitSha = useMemo<string | undefined>(() => {
    const sha = taskProjection?.lastAttempt?.commitSha;
    return sha !== undefined ? String(sha).slice(0, 7) : undefined;
  }, [taskProjection]);
  if (cardExpanded) return null;
  const attemptsCount = taskProjection?.attemptsCount ?? 0;
  return (
    <>
      {attemptsCount > 0 && (
        <Text dimColor>
          {' '}
          {glyphs.bullet} {String(attemptsCount)}×
        </Text>
      )}
      {latestCommitSha !== undefined && (
        <Text dimColor>
          {' '}
          {glyphs.bullet} {latestCommitSha}
        </Text>
      )}
    </>
  );
};

/** Expanded-header `round N/M` (+ `attempt A/X` when relevant) chip for an active gen-eval task. */
export const RoundAttemptChip = ({
  cardExpanded,
  task,
}: {
  readonly cardExpanded: boolean;
  readonly task: TaskBucket;
}): React.JSX.Element | null => {
  if (!cardExpanded) return null;
  const round = task.genEvalRound;
  if (round === undefined || round <= 0) return null;
  const maxTurns = task.genEvalMaxRounds;
  // Prefer the live tracker-sourced attempt coordinates; fall back to the `perAttemptRound` division heuristic when
  // only a `maxTurns` cap is known (post-mortem replay).
  const coords = resolveAttemptCoords(task);
  if (coords === undefined) {
    return (
      <Text color={inkColors.info}>
        {' '}
        {glyphs.bullet} round {String(round)}
      </Text>
    );
  }
  const { attemptN, roundInAttempt } = coords;
  const maxAttempts = task.genEvalMaxAttempts;
  const showAttempt = attemptN > 1 || (maxAttempts !== undefined && maxAttempts > 1);
  return (
    <Text color={inkColors.info}>
      {' '}
      {glyphs.bullet}{' '}
      {showAttempt
        ? `attempt ${String(attemptN)}${maxAttempts !== undefined ? `/${String(maxAttempts)}` : ''}${coords.resumed === true ? ` ${glyphs.bullet} resumed` : ''} ${glyphs.bullet} `
        : ''}
      round {String(roundInAttempt)}
      {maxTurns !== undefined ? `/${String(maxTurns)}` : ''}
    </Text>
  );
};

/** Expanded-header ETA chip, active task only. */
export const EtaChip = ({
  cardExpanded,
  isActive,
  taskProjection,
  task,
}: {
  readonly cardExpanded: boolean;
  readonly isActive: boolean;
  readonly taskProjection: TaskProjection | undefined;
  readonly task: TaskBucket;
}): React.JSX.Element | null => {
  const round = task.genEvalRound;
  if (!cardExpanded || !isActive || round === undefined || round <= 0) return null;
  const eta = formatEtaChip(taskProjection, round, task.genEvalMaxRounds);
  if (eta === undefined) return null;
  return <Text dimColor> {eta}</Text>;
};

/**
 * One indented, optionally-truncated notice line under the header — shared shape for the blocked-reason /
 * warning-summary / idle-ticker / first-run-waiting rows.
 */
export const IndentedNotice = ({
  tone,
  icon,
  text,
  truncate = false,
}: {
  readonly tone: 'warning' | 'dim';
  readonly icon: string;
  readonly text: string;
  readonly truncate?: boolean;
}): React.JSX.Element => {
  const colorProps = tone === 'warning' ? { color: inkColors.warning } : {};
  const line = (
    <Text {...colorProps} dimColor={tone === 'dim'} wrap={truncate ? 'truncate-end' : undefined}>
      {icon} {text}
    </Text>
  );
  return (
    <Box paddingLeft={spacing.indent}>
      {truncate ? (
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          {line}
        </Box>
      ) : (
        line
      )}
    </Box>
  );
};

/** One conditional {@link IndentedNotice} — renders nothing for an empty/whitespace-only value. */
const OptionalNotice = ({
  tone,
  icon,
  text,
}: {
  readonly tone: 'warning' | 'dim';
  readonly icon: string;
  readonly text: string;
}): React.JSX.Element | null =>
  text.length > 0 ? <IndentedNotice tone={tone} icon={icon} text={collapseWhitespace(text)} truncate /> : null;

/**
 * Trim for the three MODEL-authored notice fields, sanitised BEFORE the emptiness gate rather than only on the way
 * into `collapseWhitespace` at render time.
 */
const cleanNotice = (text: string | undefined): string => sanitizeDisplayText(text ?? '').trim();

/** Resolve the (possibly empty) text for each notice line {@link HeaderNotices} can show. */
const resolveNoticeTexts = (
  task: TaskBucket,
  cardExpanded: boolean,
  blockedReason: string | undefined,
  blockedTriage: BlockedTriage | undefined,
  warningSummary: string | undefined
): {
  readonly blockedReasonText: string;
  readonly questionText: string;
  readonly whatUnblocksMeText: string;
  readonly warningSummaryText: string;
} => ({
  blockedReasonText: cleanNotice(blockedReason),
  questionText: cardExpanded ? cleanNotice(blockedTriage?.question) : '',
  whatUnblocksMeText: cardExpanded ? cleanNotice(blockedTriage?.whatUnblocksMe) : '',
  warningSummaryText: task.status === 'completed' ? (warningSummary?.trim() ?? '') : '',
});

/** Blocked-reason / flagged-completion notice lines under the header. */
export const HeaderNotices = ({
  task,
  cardExpanded,
  blockedReason,
  blockedTriage,
  warningSummary,
}: {
  readonly task: TaskBucket;
  readonly cardExpanded: boolean;
  readonly blockedReason: string | undefined;
  readonly blockedTriage: BlockedTriage | undefined;
  readonly warningSummary: string | undefined;
}): React.JSX.Element => {
  const { blockedReasonText, questionText, whatUnblocksMeText, warningSummaryText } = resolveNoticeTexts(
    task,
    cardExpanded,
    blockedReason,
    blockedTriage,
    warningSummary
  );
  return (
    <>
      <OptionalNotice tone="warning" icon={glyphs.warningGlyph} text={blockedReasonText} />
      <OptionalNotice tone="dim" icon={glyphs.unknownGlyph} text={questionText} />
      <OptionalNotice tone="dim" icon={glyphs.arrowRight} text={whatUnblocksMeText} />
      <OptionalNotice tone="warning" icon={glyphs.warningGlyph} text={warningSummaryText} />
    </>
  );
};
