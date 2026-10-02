/** Tasks panel — per-task view of an Implement run. */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import {
  type BucketedExecution,
  isInFlightBucket,
  type TaskBucket,
} from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import type { BlockedTriage, SprintState, TaskOverlay } from '@src/application/ui/tui/components/tasks-projection.ts';
import type { TaskEvaluation } from '@src/application/ui/tui/components/tasks-panel-internals/evaluation-row.tsx';
import type { RecoveryContext } from '@src/domain/entity/attempt.ts';
import { glyphs, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { computeListWindow, OverflowRow } from '@src/application/ui/tui/components/windowed-list.tsx';
import { collectKinds, InlineKindsBar } from '@src/application/ui/tui/components/tasks-panel-internals/signal-rows.tsx';
import { TaskBlock } from '@src/application/ui/tui/components/tasks-panel-internals/task-row.tsx';
import { OrphanSignals } from '@src/application/ui/tui/components/tasks-panel-internals/orphan-signals.tsx';
import { buildFlatFocusKeys } from '@src/application/ui/tui/components/tasks-panel-internals/focus-keys.ts';
import { useTasksPanelInput } from '@src/application/ui/tui/components/tasks-panel-internals/keymap.ts';

/** The per-task extras the host view supplies as parallel id-keyed maps. */
interface TaskOverlaySources {
  /**
   * Optional `taskId → RecoveryContext` map for tasks the launcher detected as resuming a prior aborted attempt.
   */
  readonly recoveringByTaskId?: ReadonlyMap<string, RecoveryContext>;
  /**
   * Map of task id → `verificationCriteria` bullets, sourced directly from `Task.verificationCriteria` by the host
   * view (no disk read, no async loader).
   */
  readonly taskCriteriaById?: ReadonlyMap<string, readonly string[]>;
  /** Optional `taskId → blockedReason` map sourced from the polled task entities. */
  readonly blockedReasonById?: ReadonlyMap<string, string>;
  /**
   * Optional `taskId → structured block triage` map sourced from the polled task entities — the generator's own
   * question and what would unblock it, when its self-block signal supplied them.
   */
  readonly blockedTriageById?: ReadonlyMap<string, BlockedTriage>;
  /** Optional `taskId → warning summary` map sourced from the polled task entities. */
  readonly warningSummaryById?: ReadonlyMap<string, string>;
  /**
   * Optional `taskId → authoritative evaluation verdict` map sourced from the polled task entities (the LAST
   * attempt's `evaluation.status`, keyed by task id).
   */
  readonly taskEvaluationById?: ReadonlyMap<string, TaskEvaluation>;
  /** Optional `taskId → pending leaf names` map for upcoming (not-yet-run) sub-steps. */
  readonly pendingSubStepsByTaskId?: ReadonlyMap<string, readonly string[]>;
  /**
   * Optional projected sprint state. When supplied the per-task header appends an ETA derived from
   * `state.tasks[i].medianRoundDurationMs * (max - currentRound)`.
   */
  readonly sprintState?: SprintState;
}

export interface TasksPanelProps extends TaskOverlaySources {
  readonly bucketed: BucketedExecution;
  readonly running: boolean;
  /** Optional id → friendly name. Falls back to first 8 chars of the id. */
  readonly nameById?: ReadonlyMap<string, string>;
  /** Max signals per task to render; older ones drop off the top. */
  readonly maxSignalsPerTask?: number;
  /** Optional card-count budget for the task list. */
  readonly maxTasks?: number;
  /** Max orphan signals to render. */
  readonly maxOrphanSignals?: number;
  /**
   * When `true` the panel claims keyboard input for row-cursor navigation (j/k or ↑/↓) and row expansion (Enter /
   * Space).
   */
  readonly inputActive?: boolean;
  /** Max sub-step rows per task to render; older ones drop off the top behind a single elision row. */
  readonly maxSubStepsPerTask?: number;
  /** Optional `v` handler — opens the read-only evaluation overlay for the FOCUSED card. */
  readonly onOpenEvaluation?: (taskId: string) => void;
  /**
   * Wall-clock reference in milliseconds — used by the idle-ticker to compute the gap between the latest stream
   * signal and "now".
   */
  readonly nowMs?: number;
  /**
   * Optional callback fired when the panel's focused card id changes (deduplicated — only called when the id value is
   * different from the previous call).
   */
  readonly onFocusedCardChange?: (taskId: string | undefined) => void;
  /**
   * Optional callback fired when the focused card's expansion state changes (deduplicated — only called when the
   * boolean value differs from the previous call).
   */
  readonly onExpandedCardChange?: (expanded: boolean) => void;
  /**
   * Ids of tasks the host considers stuck (entity `status === 'blocked'` — own-failure block or dependency-gate block
   * alike).
   */
  readonly blockedTaskIds?: ReadonlySet<string>;
  /** Optional `u` handler — revives the FOCUSED card's stuck task (see {@link blockedTaskIds}). */
  readonly onUnblock?: (taskId: string) => void;
}

interface TaskCardState {
  /** Index of the first IN-FLIGHT task in `bucketed.tasks`; `-1` when none is running. */
  readonly activeTaskIdx: number;
  readonly activeTaskId: string | undefined;
  readonly expandedTaskIds: ReadonlySet<string>;
  readonly setExpandedTaskIds: (updater: (prev: ReadonlySet<string>) => ReadonlySet<string>) => void;
  readonly isCardExpanded: (taskId: string) => boolean;
  readonly setCardCursor: (index: number) => void;
  readonly effectiveCardCursor: number;
  readonly focusedCardId: string | undefined;
  readonly focusedCardExpanded: boolean;
}

/**
 * Card-cursor / expansion state cluster for the Tasks panel — which card is focused, which cards are expanded, and
 * the auto-expand-on-activation + focused-card-change side effects.
 */
const useTaskCardState = (
  bucketed: BucketedExecution,
  onFocusedCardChange: ((taskId: string | undefined) => void) | undefined,
  onExpandedCardChange: ((expanded: boolean) => void) | undefined
): TaskCardState => {
  // The active (first in-flight) task — anchor for the `e` criteria hotkey AND the default card-cursor position.
  const activeTaskIdx = bucketed.tasks.findIndex(isInFlightBucket);
  const activeTaskId = activeTaskIdx >= 0 ? bucketed.tasks[activeTaskIdx]?.id : undefined;

  // First `blocked` bucket — the settled-run anchor of last resort.
  const firstBlockedIdx = bucketed.tasks.findIndex((t) => t.status === 'blocked');
  const firstBlockedId = firstBlockedIdx >= 0 ? bucketed.tasks[firstBlockedIdx]?.id : undefined;

  // Per-task card expansion.
  const lastTaskId = bucketed.tasks.length > 0 ? bucketed.tasks[bucketed.tasks.length - 1]?.id : undefined;
  const settledFallbackId = firstBlockedId ?? lastTaskId;
  const seedId = activeTaskId ?? settledFallbackId;
  const [expandedTaskIds, setExpandedTaskIds] = useState<ReadonlySet<string>>(
    () => new Set(seedId !== undefined ? [seedId] : [])
  );
  // Card cursor — index into `bucketed.tasks`. Default `undefined` means "no manual focus
  // yet"; the panel anchors on the active task on first interaction.
  const [cardCursor, setCardCursor] = useState<number | undefined>(undefined);

  // Seed `expandedTaskIds` with the active task whenever it transitions to a new id (post-mount transitions only —
  // mount itself is handled by the lazy initial state).
  const prevActiveTaskIdRef = useRef<string | undefined>(activeTaskId);
  useEffect(() => {
    const prevId = prevActiveTaskIdRef.current;
    prevActiveTaskIdRef.current = activeTaskId;
    if (activeTaskId !== undefined && prevId !== activeTaskId) {
      setExpandedTaskIds((prev) => {
        if (prev.has(activeTaskId)) return prev;
        const next = new Set(prev);
        next.add(activeTaskId);
        return next;
      });
    } else if (activeTaskId === undefined && prevId !== undefined && settledFallbackId !== undefined) {
      // Transitioned to settled — expand the first blocked task (or the last task) as the
      // post-run summary.
      setExpandedTaskIds((prev) => {
        if (prev.has(settledFallbackId)) return prev;
        const next = new Set(prev);
        next.add(settledFallbackId);
        return next;
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- settledFallbackId is derived from bucketed.tasks; re-running on every task append would fight the guard (prevId check ensures we only act on activeTaskId transitions, not task additions).
  }, [activeTaskId]);

  const isCardExpanded = (taskId: string): boolean => expandedTaskIds.has(taskId);

  // The card cursor — defaults to the active task on first render.
  const effectiveCardCursor = useMemo(() => {
    if (cardCursor !== undefined && cardCursor >= 0 && cardCursor < bucketed.tasks.length) return cardCursor;
    if (activeTaskIdx >= 0) return activeTaskIdx;
    if (firstBlockedIdx >= 0) return firstBlockedIdx;
    return bucketed.tasks.length - 1;
  }, [cardCursor, activeTaskIdx, firstBlockedIdx, bucketed.tasks.length]);
  const focusedCardId = effectiveCardCursor >= 0 ? bucketed.tasks[effectiveCardCursor]?.id : undefined;
  const focusedCardExpanded = focusedCardId !== undefined ? isCardExpanded(focusedCardId) : false;

  // Report focused card id upward (passive sidebar minimap). Deduped — only fires when the id changes.
  const prevFocusedCardIdRef = useRef<string | undefined>(focusedCardId);
  const onFocusedCardChangeRef = useRef(onFocusedCardChange);
  onFocusedCardChangeRef.current = onFocusedCardChange;
  useEffect(() => {
    if (focusedCardId !== prevFocusedCardIdRef.current) {
      prevFocusedCardIdRef.current = focusedCardId;
      onFocusedCardChangeRef.current?.(focusedCardId);
    }
  });

  // Report the focused card's expansion state upward (Esc-claim seam).
  const prevFocusedCardExpandedRef = useRef<boolean | undefined>(undefined);
  const onExpandedCardChangeRef = useRef(onExpandedCardChange);
  onExpandedCardChangeRef.current = onExpandedCardChange;
  useEffect(() => {
    if (focusedCardExpanded !== prevFocusedCardExpandedRef.current) {
      prevFocusedCardExpandedRef.current = focusedCardExpanded;
      onExpandedCardChangeRef.current?.(focusedCardExpanded);
    }
  });

  return {
    activeTaskIdx,
    activeTaskId,
    expandedTaskIds,
    setExpandedTaskIds,
    isCardExpanded,
    setCardCursor,
    effectiveCardCursor,
    focusedCardId,
    focusedCardExpanded,
  };
};

type TaskBlockProps = React.ComponentProps<typeof TaskBlock>;

/** Shared instance for tasks with no extras at all — keeps a card's `overlay` prop reference-stable. */
const EMPTY_OVERLAY: TaskOverlay = {};

/** Merge one id-keyed source into the accumulating overlays. */
const mergeOverlaySource = <V,>(
  into: Map<string, TaskOverlay>,
  source: ReadonlyMap<string, V> | undefined,
  toField: (value: V) => TaskOverlay | undefined
): void => {
  for (const [taskId, value] of source ?? []) {
    const field = toField(value);
    if (field !== undefined) into.set(taskId, { ...into.get(taskId), ...field });
  }
};

/** Fold the host's parallel id-keyed maps into one `taskId → TaskOverlay` lookup. */
const buildOverlayByTaskId = (sources: TaskOverlaySources): ReadonlyMap<string, TaskOverlay> => {
  const overlays = new Map<string, TaskOverlay>();
  mergeOverlaySource(overlays, sources.recoveringByTaskId, (recovering) => ({ recovering }));
  mergeOverlaySource(overlays, sources.taskCriteriaById, (b) => (b.length > 0 ? { taskCriteria: b } : undefined));
  mergeOverlaySource(overlays, sources.blockedReasonById, (blockedReason) => ({ blockedReason }));
  mergeOverlaySource(overlays, sources.blockedTriageById, (blockedTriage) => ({ blockedTriage }));
  mergeOverlaySource(overlays, sources.warningSummaryById, (warningSummary) => ({ warningSummary }));
  mergeOverlaySource(overlays, sources.taskEvaluationById, (taskEvaluation) => ({ taskEvaluation }));
  mergeOverlaySource(overlays, sources.pendingSubStepsByTaskId, (l) =>
    l.length > 0 ? { pendingSubSteps: l } : undefined
  );
  // Keyed by id (not position) so the projection order — stored by `order` — doesn't have to
  // mirror the bucketed order, which tracks the runtime sequence.
  const projections = new Map((sources.sprintState?.tasks ?? []).map((p) => [p.id, p]));
  mergeOverlaySource(overlays, projections, (taskProjection) => ({ taskProjection }));
  return overlays;
};

/**
 * Render-derived values shared by every row this render — the card-cursor/expansion state, the folded per-task
 * overlays and the panel-level settings — bundled so {@link buildTaskRowProps} takes one argument.
 */
interface TaskRowDerived {
  readonly running: boolean;
  readonly nameById: ReadonlyMap<string, string> | undefined;
  readonly maxSubSteps: number;
  readonly overlayByTaskId: ReadonlyMap<string, TaskOverlay>;
  readonly effectiveFocusedKey: string | undefined;
  readonly expandedKeys: ReadonlySet<string>;
  readonly criteriaExpandedIds: ReadonlySet<string>;
  readonly noSignalsYet: boolean;
  readonly activeTaskIdx: number;
  readonly effectiveCardCursor: number;
  readonly isCardExpanded: (taskId: string) => boolean;
  readonly effectiveNowMs: number;
  readonly maxSignalsPerTask: number;
}

/**
 * Pure per-task derivation for one `TaskBlock` row — absolute index, display name, and this task's overlay.
 */
const buildTaskRowProps = (task: TaskBucket, idx: number, derived: TaskRowDerived): TaskBlockProps => {
  // Deliberate stylistic 8-char short-uuid fallback (NOT a width-driven clip) — keeps the header readable when the
  // launcher hasn't supplied a friendly name.
  const display = derived.nameById?.get(task.id) ?? `${task.id.slice(0, 8)}${glyphs.clipEllipsis}`;
  return {
    task,
    running: derived.running,
    display,
    maxSignals: derived.maxSignalsPerTask,
    maxSubSteps: derived.maxSubSteps,
    focusedKey: derived.effectiveFocusedKey,
    expandedKeys: derived.expandedKeys,
    criteriaExpanded: derived.criteriaExpandedIds.has(task.id),
    isActive: idx === derived.activeTaskIdx,
    firstRun: derived.noSignalsYet,
    cardExpanded: derived.isCardExpanded(task.id),
    cardFocused: idx === derived.effectiveCardCursor,
    nowMs: derived.effectiveNowMs,
    overlay: derived.overlayByTaskId.get(task.id) ?? EMPTY_OVERLAY,
  };
};

/** The windowed run of task cards. */
const TaskCards = ({
  tasks,
  maxTasks,
  derived,
}: {
  readonly tasks: readonly TaskBucket[];
  readonly maxTasks: number | undefined;
  readonly derived: TaskRowDerived;
}): React.JSX.Element => {
  const window = computeListWindow(tasks.length, derived.effectiveCardCursor, maxTasks ?? tasks.length);
  return (
    <>
      <OverflowRow direction="above" count={window.hiddenAbove} label="more above" />
      {tasks.slice(window.start, window.end).map((task, sliceIdx) => (
        // `isActive` / `cardFocused` compare against absolute indices, so recover the absolute
        // position from the slice offset.
        <TaskBlock key={task.id} {...buildTaskRowProps(task, window.start + sliceIdx, derived)} />
      ))}
      <OverflowRow direction="below" count={window.hiddenBelow} label="more below" />
    </>
  );
};

/** Empty-run placeholder — no tasks and no orphan signals yet. */
const EmptyTasksPanel = (): React.JSX.Element => (
  <Box paddingX={spacing.indent}>
    <Text dimColor>
      {glyphs.bullet} Tasks panel empty {glyphs.bullet} Run plan to generate tasks
    </Text>
  </Box>
);

/** Memoized {@link buildOverlayByTaskId}. */
const useTaskOverlays = (sources: TaskOverlaySources): ReadonlyMap<string, TaskOverlay> =>
  useMemo(
    () => buildOverlayByTaskId(sources),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see the docstring: `sources` itself is a new object identity every render; its maps are the real inputs.
    [
      sources.recoveringByTaskId,
      sources.taskCriteriaById,
      sources.blockedReasonById,
      sources.blockedTriageById,
      sources.warningSummaryById,
      sources.taskEvaluationById,
      sources.pendingSubStepsByTaskId,
      sources.sprintState,
    ]
  );

/** Stable empty-set reference for the `blockedTaskIds` default — never recreated per render. */
const NO_BLOCKED_TASK_IDS: ReadonlySet<string> = new Set();

/**
 * Bundles the "is anything settled yet" flag and the `TaskRowDerived` record every task card reads from.
 */
const buildRenderDerived = (
  bucketed: BucketedExecution,
  cardState: TaskCardState,
  rowSettings: Omit<TaskRowDerived, keyof TaskCardState | 'noSignalsYet'>
): TaskRowDerived => {
  // First-run state — tasks exist but no harness signal has fired yet across the whole run.
  const noSignalsYet =
    bucketed.orphanSignals.length === 0 &&
    bucketed.tasks.every((t) => t.signals.length === 0 && t.evaluations.length === 0);
  return { ...cardState, ...rowSettings, noSignalsYet };
};

export const TasksPanel = ({
  bucketed,
  running,
  nameById,
  maxSignalsPerTask = 8,
  maxTasks,
  maxOrphanSignals = 6,
  inputActive = false,
  maxSubStepsPerTask = 12,
  nowMs,
  onFocusedCardChange,
  onExpandedCardChange,
  onOpenEvaluation,
  blockedTaskIds = NO_BLOCKED_TASK_IDS,
  onUnblock,
  ...overlaySources
}: TasksPanelProps): React.JSX.Element => {
  // Render-time fallback for the idle-ticker clock.
  const effectiveNowMs = nowMs ?? Date.now();
  const flatKeys = useMemo(
    () => buildFlatFocusKeys(bucketed, maxSignalsPerTask, maxOrphanSignals),
    [bucketed, maxSignalsPerTask, maxOrphanSignals]
  );

  // Cursor identity is the focused row's stable key (not its index).
  const [focusedKey, setFocusedKey] = useState<string | undefined>(undefined);
  const [expandedKeys, setExpandedKeys] = useState<ReadonlySet<string>>(() => new Set<string>());
  // No lazy hydration — `taskCriteriaById` is supplied synchronously by the host view from
  // `Task.verificationCriteria`.
  const [criteriaExpandedIds, setCriteriaExpandedIds] = useState<ReadonlySet<string>>(() => new Set());

  // One folded `taskId → TaskOverlay` lookup replacing the host's parallel maps — see
  // `buildOverlayByTaskId`.
  const overlayByTaskId = useTaskOverlays(overlaySources);

  // Card-cursor / expansion state — see `useTaskCardState`.
  const cardState = useTaskCardState(bucketed, onFocusedCardChange, onExpandedCardChange);

  const focusedIndex = focusedKey !== undefined ? flatKeys.indexOf(focusedKey) : -1;
  const effectiveFocusedKey = focusedIndex >= 0 ? focusedKey : undefined;

  // Task ids the `v` chord may open — exactly those with a recorded verdict, so pressing `v` on a
  // pending / not-yet-evaluated card falls through instead of opening an empty overlay.
  const evaluationTaskIds = useMemo(
    () => new Set(overlaySources.taskEvaluationById?.keys() ?? []),
    [overlaySources.taskEvaluationById]
  );

  useTasksPanelInput({
    inputActive,
    bucketed,
    flatKeys,
    focusedKey,
    focusedIndex,
    effectiveFocusedKey,
    setFocusedKey,
    setExpandedKeys,
    setCriteriaExpandedIds,
    evaluationTaskIds,
    blockedTaskIds,
    ...(onOpenEvaluation !== undefined ? { onOpenEvaluation } : {}),
    ...(onUnblock !== undefined ? { onUnblock } : {}),
    ...cardState,
  });

  if (bucketed.tasks.length === 0 && bucketed.orphanSignals.length === 0) {
    return <EmptyTasksPanel />;
  }
  const derived = buildRenderDerived(bucketed, cardState, {
    running,
    nameById,
    maxSubSteps: maxSubStepsPerTask,
    overlayByTaskId,
    effectiveFocusedKey,
    expandedKeys,
    criteriaExpandedIds,
    effectiveNowMs,
    maxSignalsPerTask,
  });
  return (
    <Box flexDirection="column" paddingX={spacing.indent}>
      <InlineKindsBar kinds={collectKinds(bucketed)} />
      <OrphanSignals
        signals={bucketed.orphanSignals}
        max={maxOrphanSignals}
        focusedKey={effectiveFocusedKey}
        expandedKeys={expandedKeys}
      />
      <TaskCards tasks={bucketed.tasks} maxTasks={maxTasks} derived={derived} />
    </Box>
  );
};
