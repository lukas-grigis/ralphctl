/**
 * Per-task block + cross-task notes pin for the Tasks panel:
 *
 *   - {@link TaskBlock}     — one task card (header, criteria, sub-steps, eval verdict, signals)
 *   - {@link OrphanSignals} — cross-task notes pinned above the per-task blocks
 *
 * Smaller card parts (status / sub-step presentation maps, {@link RecoveryLine},
 * {@link SubStepLine}, {@link CriteriaBlock}) live in `task-card-parts.tsx` so this file stays
 * focused on header layout + the card sub-sections (criteria / sub-steps / eval verdict / signals).
 * Within this file, {@link TaskBlock} itself only composes card sub-sections — each sub-section is
 * a small, self-gating component (checks its own `cardExpanded` / data-presence condition and
 * returns `null` when it has nothing to show) so the composing card never repeats a gate.
 *
 * The eval verdict is sourced from the AUTHORITATIVE per-task `taskEvaluation` prop (the task
 * entity's last attempt, keyed by task id) — never the timestamp-bucketed `TaskBucket.evaluations`
 * signal stream, which mis-attributes evaluator signals to the wrong task under parallel/wave
 * sprints (overlapping windows + AI-fabricated timestamps).
 */

import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { resolveAttemptCoords, type TaskBucket } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
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

/**
 * Cursor caret, status glyph/spinner, display name, duration, and status word — the header's
 * fixed-position core, rendered collapsed OR expanded.
 */
const TaskHeaderCore = ({
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
const HeaderSummaryChips = ({
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
const RoundAttemptChip = ({
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
const EtaChip = ({
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
const IndentedNotice = ({
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
 * Blocked-reason / flagged-completion notice lines under the header. Rendered collapsed OR
 * expanded — a blocked card's reason, or a done card's final-attempt warning, is its most
 * important line regardless of expand state. Self-gates: renders nothing when both are empty.
 */
const HeaderNotices = ({
  task,
  blockedReason,
  warningSummary,
}: {
  readonly task: TaskBucket;
  readonly blockedReason: string | undefined;
  readonly warningSummary: string | undefined;
}): React.JSX.Element => {
  // Guard an empty / whitespace-only blockedReason (both `BlockedTask.blockedReason` and the
  // task-blocked signal permit ''): without this an AI that self-blocks with a blank reason
  // renders a lone warning glyph. trim() first — `collapseWhitespace('')` is '' but a
  // whitespace-only string collapses to a single space, which `!== undefined` alone wouldn't catch.
  const blockedReasonText = blockedReason?.trim() ?? '';
  // Warning summary for a flagged completion — rendered only for a done (`completed`) card so it
  // never competes with the blocked-reason line (mutually exclusive by status). Empty / absent →
  // no line, keeping a clean pass visually identical to its pre-change rendering.
  const warningSummaryText = task.status === 'completed' ? (warningSummary?.trim() ?? '') : '';
  return (
    <>
      {blockedReasonText.length > 0 && (
        <IndentedNotice
          tone="warning"
          icon={glyphs.warningGlyph}
          text={collapseWhitespace(blockedReasonText)}
          truncate
        />
      )}
      {warningSummaryText.length > 0 && (
        <IndentedNotice
          tone="warning"
          icon={glyphs.warningGlyph}
          text={collapseWhitespace(warningSummaryText)}
          truncate
        />
      )}
    </>
  );
};

/** Two-role gen-eval activity indicator, active+expanded task only. Self-gates internally. */
const ActiveBusyIndicator = ({
  cardExpanded,
  isActive,
  task,
}: {
  readonly cardExpanded: boolean;
  readonly isActive: boolean;
  readonly task: TaskBucket;
}): React.JSX.Element | null => {
  const isSpinning = task.status === 'running';
  if (!cardExpanded || !isActive || !isSpinning) return null;
  return <BusyIndicator role={resolveActiveRole(task.subSteps)} />;
};

/** Executed + pending sub-step rows under an expanded card. */
const SubStepsSection = ({
  taskId,
  subStepRows,
  subStepElided,
  pendingSubSteps,
  running,
}: {
  readonly taskId: string;
  readonly subStepRows: TaskBucket['subSteps'];
  readonly subStepElided: number;
  readonly pendingSubSteps: readonly string[] | undefined;
  readonly running: boolean;
}): React.JSX.Element => (
  <Box flexDirection="column" paddingLeft={spacing.indent}>
    {subStepElided > 0 && <Text dimColor>{`${glyphs.clipEllipsis} ${String(subStepElided)} earlier sub-steps`}</Text>}
    {subStepRows.map((s, i) => (
      <SubStepLine key={`${taskId}-sub-${String(i)}`} sub={s} running={running} />
    ))}
    {/* Pending sub-steps from the plan — not yet executed. Grey ◇ rows, matching the Steps rail. */}
    {pendingSubSteps !== undefined &&
      pendingSubSteps.map((leafName) => (
        <Box key={`${taskId}-pending-${leafName}`}>
          <Text color={inkColors.muted}>
            {glyphs.activityArrow} {glyphs.phasePending}
          </Text>
          <Text dimColor> {leafName}</Text>
        </Box>
      ))}
  </Box>
);

/**
 * Eval verdict block under an expanded card. Dev-gated per-dimension panel visibility is driven
 * by the AUTHORITATIVE verdict (or a failed/blocked task status) — never by a bucketed FAILED
 * signal, which can leak from another lane onto a passed task's card. When it does render it may
 * read the most recent matching bucketed FAILED signal for dimension/critique DISPLAY detail; if
 * none exists we render the compact authoritative line instead.
 */
const EvalVerdictSection = ({
  taskEvaluation,
  taskStatus,
  evaluations,
  showEvaluatorFailureUI,
}: {
  readonly taskEvaluation: TaskEvaluation;
  readonly taskStatus: TaskBucket['status'];
  readonly evaluations: TaskBucket['evaluations'];
  readonly showEvaluatorFailureUI: boolean;
}): React.JSX.Element => {
  const authoritativeFailed = taskEvaluation.status === 'failed' || taskStatus === 'failed' || taskStatus === 'aborted';
  if (showEvaluatorFailureUI && authoritativeFailed) {
    const failureSignal = [...evaluations].reverse().find((e) => e.status === 'failed');
    if (failureSignal !== undefined) {
      // Still running ⇒ the harness will feed the critique into another round.
      return (
        <Box flexDirection="column" paddingLeft={spacing.indent} marginTop={spacing.section}>
          <EvaluatorFailurePanel evaluation={failureSignal} isFinalRound={taskStatus !== 'running'} />
        </Box>
      );
    }
  }
  return (
    <Box flexDirection="column" paddingLeft={spacing.indent} marginTop={spacing.section}>
      <EvaluationLine evaluation={taskEvaluation} />
    </Box>
  );
};

/** Signals block under an expanded card. */
const SignalsSection = ({
  taskId,
  signalRows,
  signalsElided,
  focusedKey,
  expandedKeys,
  scopeId,
  sliceStart,
}: {
  readonly taskId: string;
  readonly signalRows: TaskBucket['signals'];
  readonly signalsElided: number;
  readonly focusedKey: string | undefined;
  readonly expandedKeys: ReadonlySet<string>;
  readonly scopeId: string;
  readonly sliceStart: number;
}): React.JSX.Element => (
  <Box flexDirection="column" paddingLeft={spacing.indent} marginTop={spacing.section}>
    <Text dimColor>signals</Text>
    <Box flexDirection="column" paddingLeft={spacing.indent}>
      {signalsElided > 0 && (
        <Text
          dimColor
        >{`${glyphs.clipEllipsis} ${String(signalsElided)} earlier signal${signalsElided === 1 ? '' : 's'}`}</Text>
      )}
      {signalRows.map((s, i) => {
        const key = focusKey(scopeId, sliceStart + i);
        return (
          <StreamSignalRow
            key={`${taskId}-sig-${String(sliceStart + i)}`}
            signal={s}
            focused={focusedKey === key}
            expanded={expandedKeys.has(key)}
          />
        );
      })}
    </Box>
  </Box>
);

/**
 * Idle ticker / resume banner / first-run hint / criteria / error message — the "notice-ish"
 * rows directly under the header. Self-gates on `cardExpanded`.
 */
const ExpandedNotices = ({
  cardExpanded,
  task,
  nowMs,
  isActive,
  recovering,
  firstRun,
  criteriaBullets,
  criteriaExpanded,
}: {
  readonly cardExpanded: boolean;
  readonly task: TaskBucket;
  readonly nowMs: number;
  readonly isActive: boolean;
  readonly recovering: RecoveryContext | undefined;
  readonly firstRun: boolean;
  readonly criteriaBullets: readonly string[] | undefined;
  readonly criteriaExpanded: boolean;
}): React.JSX.Element | null => {
  const isSpinning = task.status === 'running';
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
  if (!cardExpanded) return null;
  return (
    <>
      {idleSnippets.length > 0 && (
        <IndentedNotice
          tone="dim"
          icon={glyphs.activityArrow}
          text={idleSnippets.map((s) => collapseWhitespace(s)).join(`  ${glyphs.bullet}  `)}
          truncate
        />
      )}
      {recovering !== undefined && <RecoveryLine attemptN={recovering.fromAttemptN + 1} context={recovering} />}
      {firstRun && isActive && isSpinning && (
        <IndentedNotice tone="dim" icon={glyphs.activityArrow} text="waiting for first attempt…" />
      )}
      {criteriaBullets !== undefined && criteriaBullets.length > 0 && (
        <CriteriaBlock bullets={criteriaBullets} expanded={criteriaExpanded} />
      )}
      {task.errorMessage !== undefined && (
        <Box paddingLeft={spacing.indent}>
          <Text color={inkColors.error}>{task.errorMessage}</Text>
        </Box>
      )}
    </>
  );
};

/**
 * Sub-steps, eval verdict (or its "awaiting eval" placeholder), and signals — the trailing,
 * data-heavy rows of an expanded card. Self-gates on `cardExpanded`; slices `task.subSteps` /
 * `task.signals` to the render window itself so the caller only threads the raw task + limits.
 */
const ExpandedProgressBlock = ({
  cardExpanded,
  task,
  maxSubSteps,
  maxSignals,
  pendingSubSteps,
  running,
  isActive,
  taskEvaluation,
  showEvaluatorFailureUI,
  focusedKey,
  expandedKeys,
  scopeId,
  sliceStart,
}: {
  readonly cardExpanded: boolean;
  readonly task: TaskBucket;
  readonly maxSubSteps: number;
  readonly maxSignals: number;
  readonly pendingSubSteps: readonly string[] | undefined;
  readonly running: boolean;
  readonly isActive: boolean;
  readonly taskEvaluation: TaskEvaluation | undefined;
  readonly showEvaluatorFailureUI: boolean;
  readonly focusedKey: string | undefined;
  readonly expandedKeys: ReadonlySet<string>;
  readonly scopeId: string;
  readonly sliceStart: number;
}): React.JSX.Element | null => {
  if (!cardExpanded) return null;
  const subStepRows = task.subSteps.slice(-maxSubSteps);
  const subStepElided = task.subSteps.length - subStepRows.length;
  const signalRows = task.signals.slice(-maxSignals);
  const signalsElided = task.signals.length - signalRows.length;
  return (
    <>
      {(subStepRows.length > 0 || (pendingSubSteps !== undefined && pendingSubSteps.length > 0)) && (
        <SubStepsSection
          taskId={task.id}
          subStepRows={subStepRows}
          subStepElided={subStepElided}
          pendingSubSteps={pendingSubSteps}
          running={running}
        />
      )}
      {isActive && taskEvaluation === undefined && (
        // An active card with no AUTHORITATIVE evaluation yet — surface a single dim placeholder
        // so the operator sees the eval slot is live-but-empty rather than missing. We gate on the
        // ABSENCE of an authoritative verdict (not the bucketed signal stream, which can mis-
        // attribute a stale signal). `activityArrow` matches the other indented continuation lines.
        <Box paddingLeft={spacing.indent} marginTop={spacing.section}>
          <Text dimColor>{glyphs.activityArrow} awaiting eval</Text>
        </Box>
      )}
      {taskEvaluation !== undefined && (
        <EvalVerdictSection
          taskEvaluation={taskEvaluation}
          taskStatus={task.status}
          evaluations={task.evaluations}
          showEvaluatorFailureUI={showEvaluatorFailureUI}
        />
      )}
      {signalRows.length > 0 && (
        <SignalsSection
          taskId={task.id}
          signalRows={signalRows}
          signalsElided={signalsElided}
          focusedKey={focusedKey}
          expandedKeys={expandedKeys}
          scopeId={scopeId}
          sliceStart={sliceStart}
        />
      )}
    </>
  );
};

/**
 * Props for {@link TaskBlock}. Named (rather than inlined on the function) purely to keep the
 * function body's own line count legible — the shape and every field's contract are unchanged.
 */
type TaskBlockProps = {
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
};

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
}: TaskBlockProps): React.JSX.Element => (
  <Box flexDirection="column" marginBottom={spacing.section}>
    <Box>
      <TaskHeaderCore
        cardFocused={cardFocused}
        running={running}
        status={task.status}
        display={display}
        durationMs={task.durationMs}
      />
      <HeaderSummaryChips cardExpanded={cardExpanded} taskProjection={taskProjection} />
      <RoundAttemptChip cardExpanded={cardExpanded} task={task} />
      <EtaChip cardExpanded={cardExpanded} isActive={isActive} taskProjection={taskProjection} task={task} />
    </Box>
    <ActiveBusyIndicator cardExpanded={cardExpanded} isActive={isActive} task={task} />
    <HeaderNotices task={task} blockedReason={blockedReason} warningSummary={warningSummary} />
    <ExpandedNotices
      cardExpanded={cardExpanded}
      task={task}
      nowMs={nowMs}
      isActive={isActive}
      recovering={recovering}
      firstRun={firstRun}
      criteriaBullets={taskCriteria}
      criteriaExpanded={criteriaExpanded}
    />
    <ExpandedProgressBlock
      cardExpanded={cardExpanded}
      task={task}
      maxSubSteps={maxSubSteps}
      maxSignals={maxSignals}
      pendingSubSteps={pendingSubSteps}
      running={running}
      isActive={isActive}
      taskEvaluation={taskEvaluation}
      showEvaluatorFailureUI={showEvaluatorFailureUI}
      focusedKey={focusedKey}
      expandedKeys={expandedKeys}
      scopeId={scopeId}
      sliceStart={sliceStart}
    />
  </Box>
);

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
      <Box flexDirection="column" paddingLeft={spacing.indent}>
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
