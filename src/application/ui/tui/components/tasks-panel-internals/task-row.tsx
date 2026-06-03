/**
 * Per-task block + cross-task notes pin for the Tasks panel:
 *
 *   - {@link TaskBlock}     — one task card (header, criteria, sub-steps, evaluations, signals)
 *   - {@link OrphanSignals} — cross-task notes pinned above the per-task blocks
 *
 * Smaller card parts (status / sub-step presentation maps, {@link RecoveryLine},
 * {@link SubStepLine}, {@link CriteriaBlock}) live in `task-card-parts.tsx` so this file stays
 * focused on header layout + the four signal-stream sub-sections (criteria / sub-steps /
 * evaluations / signals).
 */

import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { perAttemptRound, type TaskBucket } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import type { TaskProjection } from '@src/application/ui/tui/components/tasks-projection.ts';
import type { RecoveryContext } from '@src/domain/entity/attempt.ts';
import type { HarnessSignal } from '@src/domain/signal.ts';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { fmtDuration } from '@src/application/ui/tui/theme/duration.ts';
import { EvaluatorFailurePanel } from '@src/application/ui/tui/components/evaluator-failure-panel.tsx';
import { Spinner } from '@src/application/ui/tui/components/spinner.tsx';
import {
  collapseWhitespace,
  FOCUS_CURSOR,
  formatEtaChip,
  IDLE_TICKER_THRESHOLD_MS,
  latestIdleSnippets,
} from '@src/application/ui/tui/components/tasks-panel-internals/format.ts';
import { focusKey } from '@src/application/ui/tui/components/tasks-panel-internals/focus-keys.ts';
import { EvaluationLine } from '@src/application/ui/tui/components/tasks-panel-internals/evaluation-row.tsx';
import { StreamSignalRow } from '@src/application/ui/tui/components/tasks-panel-internals/signal-rows.tsx';
import {
  CriteriaBlock,
  RecoveryLine,
  STATUS_PRESENTATION,
  SubStepLine,
} from '@src/application/ui/tui/components/tasks-panel-internals/task-card-parts.tsx';

export const TaskBlock = ({
  task,
  running,
  display,
  maxSignals,
  maxSubSteps,
  maxEvaluations,
  recovering,
  focusedKey,
  expandedKeys,
  scopeId,
  sliceStart,
  taskCriteria,
  criteriaExpanded,
  showEvaluatorFailureUI,
  taskProjection,
  isActive,
  firstRun,
  cardExpanded,
  cardFocused,
  nowMs,
  blockedReason,
}: {
  readonly task: TaskBucket;
  readonly running: boolean;
  readonly display: string;
  readonly maxSignals: number;
  readonly maxSubSteps: number;
  readonly maxEvaluations: number;
  readonly recovering?: RecoveryContext;
  readonly focusedKey: string | undefined;
  readonly expandedKeys: ReadonlySet<string>;
  readonly scopeId: string;
  /** Absolute signal index where the rendered slice starts (`task.signals.length - sliceLen`). */
  readonly sliceStart: number;
  /** Pre-resolved verification criteria for this task (audit [05]) — supplied by the host. */
  readonly taskCriteria?: readonly string[];
  /** When true the criteria block renders all bullets; otherwise the 3-line summary. */
  readonly criteriaExpanded: boolean;
  /** Dev flag — opt into the EvaluatorFailurePanel for failed evaluations. */
  readonly showEvaluatorFailureUI: boolean;
  /** Projected task entry — sourced from `sprintState.tasks` when available. */
  readonly taskProjection?: TaskProjection;
  /** True for the active (running) task; gates ETA rendering to the operator's focus. */
  readonly isActive: boolean;
  /**
   * Run-wide first-run flag — true when no harness signal or evaluation has fired across any
   * task in the panel. Surfaces a `waiting for first attempt…` line below the active task's
   * spinner so the operator sees the run is alive but pre-signal.
   */
  readonly firstRun: boolean;
  /**
   * When `true` the full card body (criteria, sub-steps, evaluations, signals) renders. When
   * `false` only the one-line header summary is shown — the operator expands by focusing the
   * card cursor and pressing Enter / Space.
   */
  readonly cardExpanded: boolean;
  /** Card-level focus indicator — drives the leading cursor caret on the header row. */
  readonly cardFocused: boolean;
  /** Wall-clock reference for the idle ticker (current time, ms epoch). */
  readonly nowMs: number;
  /**
   * Why this task is blocked — the entity's `Task.blockedReason`, supplied by the host from the
   * polled task state (the live `TaskBucket` status is trace-derived and carries no reason). When
   * present, a one-line reason renders under the header so the operator sees WHY a card blocked
   * (own failure vs `blocked upstream — …`) instead of a bare status. Absent for non-blocked tasks.
   */
  readonly blockedReason?: string;
}): React.JSX.Element => {
  const presentation = STATUS_PRESENTATION[task.status];
  const isSpinning = task.status === 'running';
  const signalRows = task.signals.slice(-maxSignals);
  const signalsElided = task.signals.length - signalRows.length;
  const subStepRows = task.subSteps.slice(-maxSubSteps);
  const subStepElided = task.subSteps.length - subStepRows.length;
  const evalRows = task.evaluations.slice(-maxEvaluations);
  const evalElided = task.evaluations.length - evalRows.length;
  const criteriaBullets = taskCriteria;
  // Guard an empty / whitespace-only blockedReason (both `BlockedTask.blockedReason` and the
  // task-blocked signal permit ''): without this an AI that self-blocks with a blank reason
  // renders a lone warning glyph. trim() first — `collapseWhitespace('')` is '' but a
  // whitespace-only string collapses to a single space, which `!== undefined` alone wouldn't catch.
  const blockedReasonText = blockedReason?.trim() ?? '';
  // Most recent commit SHA for the collapsed summary line — sourced from the projection's
  // lastAttempt when a TaskProjection is supplied. Truncated to 7 chars (git's `--short`
  // default).
  const latestCommitSha = useMemo<string | undefined>(() => {
    const sha = taskProjection?.lastAttempt?.commitSha;
    return sha !== undefined ? String(sha).slice(0, 7) : undefined;
  }, [taskProjection]);
  const attemptsCount = taskProjection?.attemptsCount ?? 0;
  // Idle ticker — surfaces the last 1–2 note / learning signals when the task is running and
  // the most recent stream signal is older than IDLE_TICKER_THRESHOLD_MS. Provides reassurance
  // that the harness is alive during long tool calls; hides immediately when a new signal
  // lands. Active task only — completed / blocked cards have no use for "what's the AI been
  // thinking about" hints.
  const idleSnippets = useMemo<readonly string[]>(() => {
    if (!isActive || !isSpinning) return [];
    const latest = task.signals[task.signals.length - 1];
    if (latest === undefined) return [];
    const latestMs = new Date(String(latest.timestamp)).getTime();
    if (!Number.isFinite(latestMs)) return [];
    if (nowMs - latestMs < IDLE_TICKER_THRESHOLD_MS) return [];
    return latestIdleSnippets(task.signals);
  }, [task.signals, isActive, isSpinning, nowMs]);
  return (
    <Box flexDirection="column" marginBottom={spacing.section}>
      <Box>
        <Text color={cardFocused ? inkColors.highlight : inkColors.muted} bold={cardFocused}>
          {cardFocused ? FOCUS_CURSOR : ' '}{' '}
        </Text>
        {isSpinning ? (
          <Spinner active={running} color={presentation.color} />
        ) : (
          <Text color={presentation.color} bold>
            {presentation.glyph}
          </Text>
        )}
        <Text bold> {display}</Text>
        {task.durationMs !== undefined && (
          <Text dimColor>
            {' '}
            {glyphs.bullet} {fmtDuration(task.durationMs)}
          </Text>
        )}
        <Text dimColor>
          {' '}
          {glyphs.bullet} {task.status}
        </Text>
        {!cardExpanded && attemptsCount > 0 && (
          <Text dimColor>
            {' '}
            {glyphs.bullet} {String(attemptsCount)}×
          </Text>
        )}
        {!cardExpanded && latestCommitSha !== undefined && (
          <Text dimColor>
            {' '}
            {glyphs.bullet} {latestCommitSha}
          </Text>
        )}
        {cardExpanded &&
          task.genEvalRound !== undefined &&
          task.genEvalRound > 0 &&
          (() => {
            const maxTurns = task.genEvalMaxRounds;
            // No per-attempt cap known → show the bare round (no `/M` that could overshoot).
            if (maxTurns === undefined) {
              return (
                <Text color={inkColors.info}>
                  {' '}
                  {glyphs.bullet} round {String(task.genEvalRound)}
                </Text>
              );
            }
            // `genEvalRound` is monotonic across the whole task; fold it back into the
            // per-attempt window so a 2nd+ attempt reads `attempt A · round R/maxTurns`
            // instead of overshooting (`round 4/3`).
            const { attemptN, roundInAttempt } = perAttemptRound(task.genEvalRound, maxTurns);
            const maxAttempts = task.genEvalMaxAttempts;
            const showAttempt = attemptN > 1 || (maxAttempts !== undefined && maxAttempts > 1);
            return (
              <Text color={inkColors.info}>
                {' '}
                {glyphs.bullet}{' '}
                {showAttempt
                  ? `attempt ${String(attemptN)}${maxAttempts !== undefined ? `/${String(maxAttempts)}` : ''} ${glyphs.bullet} `
                  : ''}
                round {String(roundInAttempt)}/{String(maxTurns)}
              </Text>
            );
          })()}
        {cardExpanded &&
          isActive &&
          task.genEvalRound !== undefined &&
          task.genEvalRound > 0 &&
          (() => {
            const eta = formatEtaChip(taskProjection, task.genEvalRound, task.genEvalMaxRounds);
            if (eta === undefined) return null;
            return <Text dimColor> {eta}</Text>;
          })()}
      </Box>
      {blockedReasonText.length > 0 && (
        // Shown collapsed OR expanded — a blocked card's reason is its most important line.
        <Box paddingLeft={2}>
          <Box flexGrow={1} flexShrink={1}>
            <Text color={inkColors.warning} wrap="truncate-end">
              {glyphs.warningGlyph} {collapseWhitespace(blockedReasonText)}
            </Text>
          </Box>
        </Box>
      )}
      {cardExpanded && idleSnippets.length > 0 && (
        <Box paddingLeft={2}>
          <Box flexGrow={1} flexShrink={1}>
            <Text dimColor wrap="truncate-end">
              {glyphs.activityArrow} {idleSnippets.map((s) => collapseWhitespace(s)).join(`  ${glyphs.bullet}  `)}
            </Text>
          </Box>
        </Box>
      )}
      {cardExpanded && recovering !== undefined && (
        <RecoveryLine attemptN={recovering.fromAttemptN + 1} context={recovering} />
      )}
      {cardExpanded && firstRun && isActive && isSpinning && (
        <Box paddingLeft={2}>
          <Text dimColor>{glyphs.activityArrow} waiting for first attempt…</Text>
        </Box>
      )}
      {cardExpanded && criteriaBullets !== undefined && criteriaBullets.length > 0 && (
        <CriteriaBlock bullets={criteriaBullets} expanded={criteriaExpanded} />
      )}
      {cardExpanded && task.errorMessage !== undefined && (
        <Box paddingLeft={2}>
          <Text color={inkColors.error}>{task.errorMessage}</Text>
        </Box>
      )}
      {cardExpanded && subStepRows.length > 0 && (
        <Box flexDirection="column" paddingLeft={2}>
          {subStepElided > 0 && (
            <Text dimColor>{`${glyphs.clipEllipsis} ${String(subStepElided)} earlier sub-steps`}</Text>
          )}
          {subStepRows.map((s, i) => (
            <SubStepLine key={`${task.id}-sub-${String(i)}`} sub={s} running={running} />
          ))}
        </Box>
      )}
      {cardExpanded && evalRows.length > 0 && (
        <Box flexDirection="column" paddingLeft={2} marginTop={1}>
          {evalElided > 0 && <Text dimColor>{`${glyphs.clipEllipsis} ${String(evalElided)} earlier evaluations`}</Text>}
          {evalRows.map((e, i) => {
            // Dev-gated: failed evaluations render via the dedicated per-dimension panel when
            // the flag is on. Anything else (passed / malformed) keeps the canonical compact
            // line so we don't disrupt the existing layout. `isFinalRound` is approximated as
            // "this is the latest evaluation row AND the task is still running" — only then
            // will the harness feed the critique into another round.
            const isLatest = i === evalRows.length - 1;
            const willGetAnotherRound = isLatest && task.status === 'running';
            if (showEvaluatorFailureUI && e.status === 'failed') {
              return (
                <EvaluatorFailurePanel
                  key={`${task.id}-eval-${String(i)}`}
                  evaluation={e}
                  isFinalRound={!willGetAnotherRound}
                />
              );
            }
            return (
              <EvaluationLine
                key={`${task.id}-eval-${String(i)}`}
                evaluation={e}
                {...(criteriaBullets !== undefined ? { criteria: criteriaBullets } : {})}
              />
            );
          })}
        </Box>
      )}
      {cardExpanded && signalRows.length > 0 && (
        <Box flexDirection="column" paddingLeft={2} marginTop={1}>
          <Text dimColor>signals</Text>
          <Box flexDirection="column" paddingLeft={2}>
            {signalsElided > 0 && (
              <Text
                dimColor
              >{`${glyphs.clipEllipsis} ${String(signalsElided)} earlier signal${signalsElided === 1 ? '' : 's'}`}</Text>
            )}
            {signalRows.map((s, i) => {
              const key = focusKey(scopeId, sliceStart + i);
              return (
                <StreamSignalRow
                  key={`${task.id}-sig-${String(sliceStart + i)}`}
                  signal={s}
                  focused={focusedKey === key}
                  expanded={expandedKeys.has(key)}
                />
              );
            })}
          </Box>
        </Box>
      )}
    </Box>
  );
};

export const OrphanSignals = ({
  signals,
  max,
  focusedKey,
  expandedKeys,
  sliceStart,
}: {
  readonly signals: readonly HarnessSignal[];
  readonly max: number;
  readonly focusedKey: string | undefined;
  readonly expandedKeys: ReadonlySet<string>;
  /** Absolute signal index where the rendered slice starts. */
  readonly sliceStart: number;
}): React.JSX.Element | null => {
  if (signals.length === 0) return null;
  const rows = signals.slice(-max);
  // Display-clip marker (audit-[03]): when the orphan-signals list is longer than the
  // render budget, surface the count of elided rows so the operator knows earlier notes
  // exist beyond the window.
  const orphansElided = signals.length - rows.length;
  return (
    <Box flexDirection="column" marginBottom={spacing.section}>
      <Text dimColor bold>
        {glyphs.bullet} Cross-task notes
      </Text>
      <Box flexDirection="column" paddingLeft={2}>
        {orphansElided > 0 && (
          <Text
            dimColor
          >{`${glyphs.clipEllipsis} ${String(orphansElided)} earlier note${orphansElided === 1 ? '' : 's'}`}</Text>
        )}
        {rows.map((s, i) => {
          const key = focusKey('orphan', sliceStart + i);
          return (
            <StreamSignalRow
              key={`orphan-${String(sliceStart + i)}`}
              signal={s}
              focused={focusedKey === key}
              expanded={expandedKeys.has(key)}
            />
          );
        })}
      </Box>
    </Box>
  );
};
