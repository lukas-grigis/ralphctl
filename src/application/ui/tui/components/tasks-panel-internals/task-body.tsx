/**
 * Expanded body of a task card — everything below the header cluster:
 *
 *   - {@link ActiveBusyIndicator}   — two-role gen-eval activity dot
 *   - {@link ExpandedNotices}       — idle ticker, resume banner, first-run hint, criteria, error
 *   - {@link ExpandedProgressBlock} — sub-steps, eval verdict, signals
 *
 * Each component self-gates on `cardExpanded` (and its own data-presence condition), so the
 * composing card never repeats a gate. The eval verdict is sourced from the AUTHORITATIVE
 * per-task `taskEvaluation` — never the timestamp-bucketed `TaskBucket.evaluations` signal
 * stream, which mis-attributes evaluator signals to the wrong task under parallel/wave sprints
 * (overlapping windows + AI-fabricated timestamps).
 */

import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import type { TaskBucket } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import type { RecoveryContext } from '@src/domain/entity/attempt.ts';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { EvaluatorFailurePanel } from '@src/application/ui/tui/components/evaluator-failure-panel.tsx';
import {
  collapseWhitespace,
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
  SubStepLine,
} from '@src/application/ui/tui/components/tasks-panel-internals/task-card-parts.tsx';
import { IndentedNotice } from '@src/application/ui/tui/components/tasks-panel-internals/task-header.tsx';
import { useIdleClock } from '@src/application/ui/tui/components/tasks-panel-internals/use-idle-clock.ts';

/** Two-role gen-eval activity indicator, active+expanded task only. Self-gates internally. */
export const ActiveBusyIndicator = ({
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
 * Idle-ticker hint — the only genuinely 1 Hz-dependent bit of an expanded task card. Owns its
 * own tick internally via {@link useIdleClock} (mirrors the `ElapsedLabel` pattern from
 * `execute-view-internals/elapsed-label.tsx`) instead of reading a `now` prop that the parent
 * re-renders on every second — so a clock tick re-renders only this leaf, not `TaskBlock` or the
 * rest of the card. `seedNowMs` seeds the leaf's clock on mount (the caller's freshest known
 * "now"); the leaf free-runs from `Date.now()` afterwards while `active`.
 *
 * Surfaces the last 1–2 note / learning signals when the task is running and the most recent
 * stream signal is older than `IDLE_TICKER_THRESHOLD_MS` — reassurance that the harness is alive
 * during long tool calls. Hides immediately when a new signal lands. `active` should be
 * `isActive && isSpinning` — completed / blocked / non-focused cards have no use for "what's the
 * AI been thinking about" hints and never start a timer.
 */
const IdleTickerNotice = ({
  active,
  signals,
  seedNowMs,
}: {
  readonly active: boolean;
  readonly signals: TaskBucket['signals'];
  readonly seedNowMs: number;
}): React.JSX.Element | null => {
  const now = useIdleClock(active, seedNowMs);
  const idleSnippets = useMemo<readonly string[]>(() => {
    if (!active) return [];
    const latest = signals[signals.length - 1];
    if (latest === undefined) return [];
    const latestMs = new Date(String(latest.timestamp)).getTime();
    if (!Number.isFinite(latestMs)) return [];
    if (now - latestMs < IDLE_TICKER_THRESHOLD_MS) return [];
    return latestIdleSnippets(signals);
  }, [signals, active, now]);
  if (idleSnippets.length === 0) return null;
  return (
    <IndentedNotice
      tone="dim"
      icon={glyphs.activityArrow}
      text={idleSnippets.map((s) => collapseWhitespace(s)).join(`  ${glyphs.bullet}  `)}
      truncate
    />
  );
};

/**
 * Resume banner / first-run hint / criteria / error message — the "notice-ish" rows directly
 * under the header, plus the idle ticker (delegated to {@link IdleTickerNotice}). Self-gates on
 * `cardExpanded`.
 */
export const ExpandedNotices = ({
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
  if (!cardExpanded) return null;
  return (
    <>
      <IdleTickerNotice active={isActive && isSpinning} signals={task.signals} seedNowMs={nowMs} />
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
export const ExpandedProgressBlock = ({
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
