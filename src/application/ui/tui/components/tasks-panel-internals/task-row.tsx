/** {@link TaskBlock} — one task card for the Tasks panel. */

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
 * Props for {@link TaskBlock}. Named (rather than inlined on the function) purely to keep the function body's own
 * line count legible.
 */
type TaskBlockProps = {
  readonly task: TaskBucket;
  readonly running: boolean;
  readonly display: string;
  readonly maxSignals: number;
  readonly maxSubSteps: number;
  readonly focusedKey: string | undefined;
  readonly expandedKeys: ReadonlySet<string>;
  /** When true the criteria block renders all bullets; otherwise the 3-line summary. */
  readonly criteriaExpanded: boolean;
  /** True for the active (running) task; gates ETA rendering to the operator's focus. */
  readonly isActive: boolean;
  /**
   * Run-wide first-run flag — true when no harness signal or evaluation has fired across any task in the panel.
   */
  readonly firstRun: boolean;
  /** When `true` the full card body (criteria, sub-steps, evaluations, signals) renders. */
  readonly cardExpanded: boolean;
  /** Card-level focus indicator — drives the leading cursor caret on the header row. */
  readonly cardFocused: boolean;
  /** Wall-clock reference for the idle ticker (current time, ms epoch). */
  readonly nowMs: number;
  /**
   * Entity- and projection-sourced extras for this task — see {@link TaskOverlay}. The live `TaskBucket` is
   * trace-derived and carries none of them.
   */
  readonly overlay?: TaskOverlay;
};

/** Stand-in for an omitted `overlay` — a task with no entity- or projection-sourced extras. */
const NO_OVERLAY: TaskOverlay = {};

/**
 * `TaskBlock`'s props-equality check for {@link React.memo} — identical to React's own default shallow compare EXCEPT
 * it ignores `nowMs`.
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
    <HeaderNotices
      task={task}
      cardExpanded={cardExpanded}
      blockedReason={overlay.blockedReason}
      blockedTriage={overlay.blockedTriage}
      warningSummary={overlay.warningSummary}
    />
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
      isActive={isActive}
      taskEvaluation={overlay.taskEvaluation}
      focusedKey={focusedKey}
      expandedKeys={expandedKeys}
    />
  </Box>
);

/** Memoized with the custom `nowMs`-excluding comparator above. */
export const TaskBlock = React.memo(TaskBlockImpl, taskBlockPropsEqual);
