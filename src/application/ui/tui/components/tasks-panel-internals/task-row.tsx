/**
 * Per-task block + cross-task notes pin for the Tasks panel:
 *
 *   - {@link TaskBlock}     — one task card (header, criteria, sub-steps, eval verdict, signals)
 *   - {@link OrphanSignals} — cross-task notes pinned above the per-task blocks
 *
 * Smaller card parts (status / sub-step presentation maps, {@link RecoveryLine},
 * {@link SubStepLine}, {@link CriteriaBlock}) live in `task-card-parts.tsx` so this file stays
 * focused on header layout + the card sub-sections (criteria / sub-steps / eval verdict / signals).
 *
 * The eval verdict is sourced from the AUTHORITATIVE per-task `taskEvaluation` prop (the task
 * entity's last attempt, keyed by task id) — never the timestamp-bucketed `TaskBucket.evaluations`
 * signal stream, which mis-attributes evaluator signals to the wrong task under parallel/wave
 * sprints (overlapping windows + AI-fabricated timestamps).
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
  resolveActiveRole,
} from '@src/application/ui/tui/components/tasks-panel-internals/format.ts';
import { focusKey } from '@src/application/ui/tui/components/tasks-panel-internals/focus-keys.ts';
import {
  EvaluationLine,
  type TaskEvaluation,
} from '@src/application/ui/tui/components/tasks-panel-internals/evaluation-row.tsx';
import { StreamSignalRow } from '@src/application/ui/tui/components/tasks-panel-internals/signal-rows.tsx';
import {
  BusyIndicator,
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
  warningSummary,
  taskEvaluation,
  pendingSubSteps,
}: {
  readonly task: TaskBucket;
  readonly running: boolean;
  readonly display: string;
  readonly maxSignals: number;
  readonly maxSubSteps: number;
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
  /**
   * One-line warning summary for a task that settled `done` but whose FINAL attempt carries an
   * `AttemptWarning` (budget / plateau / malformed / verify-failed). Supplied by the host from the
   * polled task entities — the live `TaskBucket` status is trace-derived and carries no warning.
   * When present a warning glyph + this summary renders under the header so the operator sees a
   * flagged completion is not a clean pass. Absent for clean / non-done tasks.
   */
  readonly warningSummary?: string;
  /**
   * AUTHORITATIVE per-task evaluation verdict — the LAST attempt's `evaluation.status`, keyed by
   * task id by the host. Drives the card's eval line AND the EvaluatorFailurePanel visibility
   * gate. We deliberately do NOT render the bucketed `TaskBucket.evaluations` signal stream as the
   * verdict: it attributes evaluator signals by timestamp window, which mis-attributes under
   * parallel/wave sprints (overlapping windows + AI-fabricated timestamps). Absent ⇒ no verdict
   * recorded yet for this task (renders "awaiting eval" while the card is active).
   */
  readonly taskEvaluation?: TaskEvaluation;
  /**
   * Upcoming (not-yet-run) sub-step leaf names for this task, derived from `descriptor.plannedLeaves`
   * by filtering to this task's UUID-suffixed entries and subtracting already-executed sub-steps.
   * Rendered as grey `◇` pending rows after the executed sub-steps so the operator sees the FULL
   * planned sequence — not just what has run.
   *
   * NOTE: generator/evaluator leaves repeat an unknown number of rounds; the host skips them from
   * the pending list. Only FIXED surrounding leaves (pre-gen-eval / post-task) are included so we
   * never fabricate a fixed count of dynamic rounds.
   *
   * Absent when `descriptor.plannedLeaves` is not available (legacy sessions / non-implement flows).
   */
  readonly pendingSubSteps?: readonly string[];
}): React.JSX.Element => {
  const presentation = STATUS_PRESENTATION[task.status];
  const isSpinning = task.status === 'running';
  const signalRows = task.signals.slice(-maxSignals);
  const signalsElided = task.signals.length - signalRows.length;
  const subStepRows = task.subSteps.slice(-maxSubSteps);
  const subStepElided = task.subSteps.length - subStepRows.length;
  const criteriaBullets = taskCriteria;
  // Guard an empty / whitespace-only blockedReason (both `BlockedTask.blockedReason` and the
  // task-blocked signal permit ''): without this an AI that self-blocks with a blank reason
  // renders a lone warning glyph. trim() first — `collapseWhitespace('')` is '' but a
  // whitespace-only string collapses to a single space, which `!== undefined` alone wouldn't catch.
  const blockedReasonText = blockedReason?.trim() ?? '';
  // Warning summary for a flagged completion — rendered only for a done (`completed`) card so it
  // never competes with the blocked-reason line (mutually exclusive by status). Empty / absent →
  // no line, keeping a clean pass visually identical to its pre-change rendering.
  const warningSummaryText = task.status === 'completed' ? (warningSummary?.trim() ?? '') : '';
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
      {cardExpanded && isActive && isSpinning && <BusyIndicator role={resolveActiveRole(task.subSteps)} />}
      {blockedReasonText.length > 0 && (
        // Shown collapsed OR expanded — a blocked card's reason is its most important line.
        <Box paddingLeft={2}>
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Text color={inkColors.warning} wrap="truncate-end">
              {glyphs.warningGlyph} {collapseWhitespace(blockedReasonText)}
            </Text>
          </Box>
        </Box>
      )}
      {warningSummaryText.length > 0 && (
        // A done card that carries a final-attempt warning — surfaced collapsed OR expanded so the
        // operator never reads a flagged completion as a clean pass. Same warning glyph as the
        // attempt-card / blocked line; the tasks list previously showed it only for blockedReason.
        <Box paddingLeft={2}>
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Text color={inkColors.warning} wrap="truncate-end">
              {glyphs.warningGlyph} {collapseWhitespace(warningSummaryText)}
            </Text>
          </Box>
        </Box>
      )}
      {cardExpanded && idleSnippets.length > 0 && (
        <Box paddingLeft={2}>
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
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
      {cardExpanded && (subStepRows.length > 0 || (pendingSubSteps !== undefined && pendingSubSteps.length > 0)) && (
        <Box flexDirection="column" paddingLeft={2}>
          {subStepElided > 0 && (
            <Text dimColor>{`${glyphs.clipEllipsis} ${String(subStepElided)} earlier sub-steps`}</Text>
          )}
          {subStepRows.map((s, i) => (
            <SubStepLine key={`${task.id}-sub-${String(i)}`} sub={s} running={running} />
          ))}
          {/* Pending sub-steps from the plan — not yet executed. Grey ◇ rows, matching the Steps rail. */}
          {pendingSubSteps !== undefined &&
            pendingSubSteps.map((leafName) => (
              <Box key={`${task.id}-pending-${leafName}`}>
                <Text color={inkColors.muted}>
                  {glyphs.activityArrow} {glyphs.phasePending}
                </Text>
                <Text dimColor> {leafName}</Text>
              </Box>
            ))}
        </Box>
      )}
      {cardExpanded && isActive && taskEvaluation === undefined && (
        // An active card with no AUTHORITATIVE evaluation yet — surface a single dim placeholder
        // so the operator sees the eval slot is live-but-empty rather than missing. We gate on the
        // ABSENCE of an authoritative verdict (not the bucketed signal stream, which can mis-
        // attribute a stale signal). `activityArrow` matches the other indented continuation lines.
        <Box paddingLeft={2} marginTop={1}>
          <Text dimColor>{glyphs.activityArrow} awaiting eval</Text>
        </Box>
      )}
      {cardExpanded &&
        taskEvaluation !== undefined &&
        (() => {
          // Dev-gated per-dimension panel. Its VISIBILITY is driven by the AUTHORITATIVE verdict
          // (or a failed/blocked task status) — never by a bucketed FAILED signal, which can leak
          // from another lane onto a passed task's card. When it does render it may read the most
          // recent matching bucketed FAILED signal for dimension/critique DISPLAY detail; if none
          // exists we render the compact authoritative line instead.
          const authoritativeFailed =
            taskEvaluation.status === 'failed' || task.status === 'failed' || task.status === 'aborted';
          if (showEvaluatorFailureUI && authoritativeFailed) {
            const failureSignal = [...task.evaluations].reverse().find((e) => e.status === 'failed');
            if (failureSignal !== undefined) {
              // Still running ⇒ the harness will feed the critique into another round.
              return (
                <Box flexDirection="column" paddingLeft={2} marginTop={1}>
                  <EvaluatorFailurePanel evaluation={failureSignal} isFinalRound={task.status !== 'running'} />
                </Box>
              );
            }
          }
          return (
            <Box flexDirection="column" paddingLeft={2} marginTop={1}>
              <EvaluationLine evaluation={taskEvaluation} />
            </Box>
          );
        })()}
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
