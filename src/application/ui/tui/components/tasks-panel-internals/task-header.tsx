/**
 * Header cluster of a task card — the rows that render whether the card is collapsed or expanded:
 *
 *   - {@link TaskHeaderCore}     — cursor caret, status glyph/spinner, name, duration, status word
 *   - {@link HeaderSummaryChips} — collapsed-only attempt count + latest commit sha
 *   - {@link RoundAttemptChip}   — expanded-only `attempt A/X · round R/M`
 *   - {@link EtaChip}            — expanded-only ETA for the active task
 *   - {@link HeaderNotices}      — blocked reason / flagged-completion warning
 *
 * Each component self-gates: it checks its own `cardExpanded` / data-presence condition and
 * returns `null` when it has nothing to show, so the composing card never repeats a gate.
 * {@link IndentedNotice} is the shared one-line notice shape, also used by the expanded body.
 */

import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { resolveAttemptCoords, type TaskBucket } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import type { BlockedTriage, TaskProjection } from '@src/application/ui/tui/components/tasks-projection.ts';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { fmtDuration } from '@src/application/ui/tui/theme/duration.ts';
import { Spinner } from '@src/application/ui/tui/components/spinner.tsx';
import { collapseWhitespace, formatEtaChip } from '@src/application/ui/tui/components/tasks-panel-internals/format.ts';
import { STATUS_PRESENTATION } from '@src/application/ui/tui/components/tasks-panel-internals/task-card-parts.tsx';

/**
 * Cursor caret, status glyph/spinner, display name, duration, and status word — the header's
 * fixed-position core, rendered collapsed OR expanded.
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
  // Most recent commit SHA for the collapsed summary line — sourced from the projection's
  // lastAttempt when a TaskProjection is supplied. Truncated to 7 chars (git's `--short`
  // default).
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

/**
 * Expanded-header `round N/M` (+ `attempt A/X` when relevant) chip for an active gen-eval task.
 * Self-gates on `cardExpanded` and on the task having entered a gen-eval round yet.
 */
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
  // Prefer the live tracker-sourced attempt coordinates; fall back to the `perAttemptRound`
  // division heuristic when only a `maxTurns` cap is known (post-mortem replay). `undefined` means
  // neither is available → show the bare round with no `/M` that could overshoot.
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
        ? `attempt ${String(attemptN)}${maxAttempts !== undefined ? `/${String(maxAttempts)}` : ''} ${glyphs.bullet} `
        : ''}
      round {String(roundInAttempt)}
      {maxTurns !== undefined ? `/${String(maxTurns)}` : ''}
    </Text>
  );
};

/**
 * Expanded-header ETA chip, active task only. Self-gates on `cardExpanded` / `isActive` / the task
 * having entered a gen-eval round, then drops (returns null) once no estimate applies.
 */
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
 * One indented, optionally-truncated notice line under the header — shared shape for the
 * blocked-reason / warning-summary / idle-ticker / first-run-waiting rows. `truncate` mirrors
 * whether the original render wrapped the `Text` in a `flexGrow`/`flexShrink`/`minWidth: 0` Box
 * with `wrap="truncate-end"` (the blocked/warning/idle rows) or rendered a bare `Text` (the
 * first-run-waiting row).
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

/**
 * One conditional {@link IndentedNotice} — renders nothing for an empty/whitespace-only value.
 * Pulled out of {@link HeaderNotices} so that component's body is a flat list of these instead of
 * four repeated `length > 0 && (...)` branches (keeps it under the file's complexity budget).
 */
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
 * Resolve the (possibly empty) text for each notice line {@link HeaderNotices} can show. Guards
 * an empty / whitespace-only `blockedReason` (both `BlockedTask.blockedReason` and the
 * task-blocked signal permit ''): without this an AI that self-blocks with a blank reason renders
 * a lone warning glyph. `warningSummary` only applies to a `completed` card (mutually exclusive
 * with a blocked one by status). `question` / `whatUnblocksMe` only apply while EXPANDED — see
 * {@link HeaderNotices}'s doc for why.
 */
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
  blockedReasonText: blockedReason?.trim() ?? '',
  questionText: cardExpanded ? (blockedTriage?.question?.trim() ?? '') : '',
  whatUnblocksMeText: cardExpanded ? (blockedTriage?.whatUnblocksMe?.trim() ?? '') : '',
  warningSummaryText: task.status === 'completed' ? (warningSummary?.trim() ?? '') : '',
});

/**
 * Blocked-reason / flagged-completion notice lines under the header. Rendered collapsed OR
 * expanded — a blocked card's reason, or a done card's final-attempt warning, is its most
 * important line regardless of expand state. Self-gates: renders nothing when both are empty.
 *
 * `blockedTriage`'s question / what-unblocks-it lines render EXPANDED ONLY (unlike the reason
 * line above them): they're the generator's own elaboration on the reason, genuinely supplementary
 * rather than the headline fact, so the collapsed one-liner stays exactly as compact as before a
 * task ever carried this structure.
 */
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
