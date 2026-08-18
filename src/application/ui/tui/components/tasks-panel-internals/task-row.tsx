/**
 * {@link TaskBlock} — one task card for the Tasks panel. This file owns only the card's props
 * contract, its memo comparator, and the composition of the parts:
 *
 *   - `task-header.tsx`      — cursor / status / name row, summary + round + ETA chips, notices
 *   - `task-body.tsx`        — busy indicator, expanded notices, sub-steps / eval / signals
 *   - `task-card-parts.tsx`  — the smallest shared leaves (status maps, recovery / sub-step /
 *                              criteria rows)
 *
 * Every part self-gates — it checks its own `cardExpanded` / data-presence condition and returns
 * `null` when it has nothing to show — so the card below never repeats a gate.
 *
 * The per-task extras (recovery context, criteria, blocked reason, warning, evaluation verdict,
 * pending sub-steps, projection) arrive as ONE {@link TaskOverlay} rather than as separate props:
 * the panel folds the host's parallel id-keyed maps into it once per change, so a card looks its
 * extras up once and the memo comparator has a single reference to compare.
 */

import React from 'react';
import { Box } from 'ink';
import type { TaskBucket } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import type { TaskOverlay } from '@src/application/ui/tui/components/tasks-projection.ts';
import { spacing } from '@src/application/ui/tui/theme/tokens.ts';
import {
  EtaChip,
  HeaderNotices,
  HeaderSummaryChips,
  RoundAttemptChip,
  TaskHeaderCore,
} from '@src/application/ui/tui/components/tasks-panel-internals/task-header.tsx';
import {
  ActiveBusyIndicator,
  ExpandedNotices,
  ExpandedProgressBlock,
} from '@src/application/ui/tui/components/tasks-panel-internals/task-body.tsx';

/**
 * Props for {@link TaskBlock}. Named (rather than inlined on the function) purely to keep the
 * function body's own line count legible.
 */
type TaskBlockProps = {
  readonly task: TaskBucket;
  readonly running: boolean;
  readonly display: string;
  readonly maxSignals: number;
  readonly maxSubSteps: number;
  readonly focusedKey: string | undefined;
  readonly expandedKeys: ReadonlySet<string>;
  readonly scopeId: string;
  /** Absolute signal index where the rendered slice starts (`task.signals.length - sliceLen`). */
  readonly sliceStart: number;
  /** When true the criteria block renders all bullets; otherwise the 3-line summary. */
  readonly criteriaExpanded: boolean;
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
   * Entity- and projection-sourced extras for this task — see {@link TaskOverlay}. The live
   * `TaskBucket` is trace-derived and carries none of them. Omitted ⇒ the card renders from the
   * bucket alone (no criteria, verdict, ETA or notices).
   */
  readonly overlay?: TaskOverlay;
};

/** Stand-in for an omitted `overlay` — a task with no entity- or projection-sourced extras. */
const NO_OVERLAY: TaskOverlay = {};

/**
 * `TaskBlock`'s props-equality check for {@link React.memo} — identical to React's own default
 * shallow compare EXCEPT it ignores `nowMs`. The host (`tasks-panel.tsx`) re-derives `nowMs` from
 * a polled 1 Hz clock every second, so a naive default `React.memo` would still re-render every
 * card on every tick even though only the idle-ticker leaf (`IdleTickerNotice`, which now owns
 * its own timer — see `use-idle-clock.ts`) ever needed it. Excluding just that one field is what
 * turns the memo into a real bail-out for the 1 Hz tick without touching the host's prop shape.
 */
const TASK_BLOCK_IGNORED_KEYS: ReadonlySet<keyof TaskBlockProps> = new Set(['nowMs']);

const taskBlockPropsEqual = (prev: TaskBlockProps, next: TaskBlockProps): boolean => {
  const keys = new Set<keyof TaskBlockProps>([
    ...(Object.keys(prev) as Array<keyof TaskBlockProps>),
    ...(Object.keys(next) as Array<keyof TaskBlockProps>),
  ]);
  for (const key of keys) {
    if (TASK_BLOCK_IGNORED_KEYS.has(key)) continue;
    if (!Object.is(prev[key], next[key])) return false;
  }
  return true;
};

const TaskBlockImpl = ({
  task,
  running,
  display,
  maxSignals,
  maxSubSteps,
  focusedKey,
  expandedKeys,
  scopeId,
  sliceStart,
  criteriaExpanded,
  isActive,
  firstRun,
  cardExpanded,
  cardFocused,
  nowMs,
  overlay = NO_OVERLAY,
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
      <HeaderSummaryChips cardExpanded={cardExpanded} taskProjection={overlay.taskProjection} />
      <RoundAttemptChip cardExpanded={cardExpanded} task={task} />
      <EtaChip cardExpanded={cardExpanded} isActive={isActive} taskProjection={overlay.taskProjection} task={task} />
    </Box>
    <ActiveBusyIndicator cardExpanded={cardExpanded} isActive={isActive} task={task} />
    <HeaderNotices task={task} blockedReason={overlay.blockedReason} warningSummary={overlay.warningSummary} />
    <ExpandedNotices
      cardExpanded={cardExpanded}
      task={task}
      nowMs={nowMs}
      isActive={isActive}
      recovering={overlay.recovering}
      firstRun={firstRun}
      criteriaBullets={overlay.taskCriteria}
      criteriaExpanded={criteriaExpanded}
    />
    <ExpandedProgressBlock
      cardExpanded={cardExpanded}
      task={task}
      maxSubSteps={maxSubSteps}
      maxSignals={maxSignals}
      pendingSubSteps={overlay.pendingSubSteps}
      running={running}
      isActive={isActive}
      taskEvaluation={overlay.taskEvaluation}
      focusedKey={focusedKey}
      expandedKeys={expandedKeys}
      scopeId={scopeId}
      sliceStart={sliceStart}
    />
  </Box>
);

/**
 * Memoized with the custom `nowMs`-excluding comparator above. `tasks-panel.tsx` rebuilds this
 * component's props from scratch every render (including every 1 Hz tick), so without a memo the
 * card would re-render regardless; with it, a card whose only "changed" prop is `nowMs` bails out
 * before touching its subtree (`ExpandedNotices`, `ExpandedProgressBlock`, …).
 */
export const TaskBlock = React.memo(TaskBlockImpl, taskBlockPropsEqual);
