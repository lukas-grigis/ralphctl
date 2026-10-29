/**
 * Tasks panel — per-task view of an Implement run:
 *
 *   ✓ <id-short> · <duration> · <status>
 *     ↳ <sub-step name>          <duration>
 *     eval passed · attempt 2
 *     signals
 *       09:19  chng  added canvas-confetti …
 *
 * Cross-task signals (outside every task window) pin at the top as "Cross-task notes". Correlation
 * lives in `bucket-task-signals.ts`; this component renders the bucketed structure, with row
 * renderers, the keyboard model and focus-key plumbing under `tasks-panel-internals/`.
 */

import type { PriorWorkNotice } from '@src/application/ui/shared/prior-work-copy.ts';
import React, { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import {
  type BucketedExecution,
  isInFlightBucket,
  type TaskBucket,
} from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import type { BlockedTriage, SprintState, TaskOverlay } from '@src/application/ui/tui/components/tasks-projection.ts';
import type { TaskEvaluation } from '@src/application/ui/tui/components/tasks-panel-internals/evaluation-row.tsx';
import type { RecoveryContext } from '@src/domain/entity/attempt.ts';
import type { StepView } from '@src/application/ui/tui/runtime/flow-progress.ts';
import { glyphs, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { computeListWindow, OverflowRow } from '@src/application/ui/tui/components/windowed-list.tsx';
import { collectKinds, InlineKindsBar } from '@src/application/ui/tui/components/tasks-panel-internals/signal-rows.tsx';
import { TaskBlock } from '@src/application/ui/tui/components/tasks-panel-internals/task-row.tsx';
import { OrphanSignals } from '@src/application/ui/tui/components/tasks-panel-internals/orphan-signals.tsx';
import { buildFlatFocusKeys } from '@src/application/ui/tui/components/tasks-panel-internals/focus-keys.ts';
import { useTasksPanelInput } from '@src/application/ui/tui/components/tasks-panel-internals/keymap.ts';

/**
 * Per-task extras the host supplies as parallel id-keyed maps (each comes from a different source:
 * descriptor, polled task entities, planned-leaf list, sprint projection); the panel folds them into
 * one {@link TaskOverlay} per task. A missing map or key just omits that part of the card.
 */
interface TaskOverlaySources {
  /** Tasks resuming a prior aborted attempt: adds `↳ attempt N · resumed from aborted M at HH:MM (CAUSE)` under the header. */
  readonly recoveringByTaskId?: ReadonlyMap<string, RecoveryContext>;
  /** `Task.verificationCriteria` bullets: non-pending headers show a 3-line summary; `e` expands the active task's full list. */
  readonly taskCriteriaById?: ReadonlyMap<string, readonly string[]>;
  /** Why a task is blocked (own failure vs `blocked upstream — …`), shown under its header. */
  readonly blockedReasonById?: ReadonlyMap<string, string>;
  /** The generator's own question / what-would-unblock-it, when its self-block signal supplied them. */
  readonly blockedTriageById?: ReadonlyMap<string, BlockedTriage>;
  /** One-line `AttemptWarning` summary for a `done` task, so a flagged completion never reads as a clean pass. */
  readonly warningSummaryById?: ReadonlyMap<string, string>;
  /** Rejected-diff notice from the polled task entities (see `priorWorkNotice`). */
  readonly priorWorkById?: ReadonlyMap<string, PriorWorkNotice>;
  /**
   * Authoritative verdict (LAST attempt's `evaluation.status`). The card renders THIS, never the
   * timestamp-bucketed `TaskBucket.evaluations`, which mis-attributes evaluator signals under
   * parallel waves. No key ⇒ "awaiting eval" while active, else no verdict line.
   */
  readonly taskEvaluationById?: ReadonlyMap<string, TaskEvaluation>;
  /** Work-item root of each task from the flow-progress projection; an expanded card renders its children as the step tree. */
  readonly stepTreeByTaskId?: ReadonlyMap<string, StepView>;
  /** Projected sprint state; when set the header appends an ETA from `medianAttemptDurationMs`. Matched to tasks by id. */
  readonly sprintState?: SprintState;
}

export interface TasksPanelProps extends TaskOverlaySources {
  readonly bucketed: BucketedExecution;
  readonly running: boolean;
  /** id → friendly name; falls back to the first 8 chars of the id. */
  readonly nameById?: ReadonlyMap<string, string>;
  /** Max signals per task; older ones drop off the top. */
  readonly maxSignalsPerTask?: number;
  /**
   * Card-count budget: beyond it the panel renders a window centred on the active / focused card
   * with "▴ N more above" / "▾ N more below" cues. Absent ⇒ every card.
   */
  readonly maxTasks?: number;
  readonly maxOrphanSignals?: number;
  /**
   * Claim keyboard input: card/row cursor (j/k, ↑/↓), expansion (Enter/Space; on a `commit-message`
   * row it reveals the body). Default `false` so isolated renders don't compete with other
   * `useInput` handlers. Expansion state is panel-local and resets on unmount.
   */
  readonly inputActive?: boolean;
  /** Row budget for one task's step tree, cues included; the window stays anchored on the running (or failed) row. */
  readonly maxSubStepsPerTask?: number;
  /** `v` handler for the FOCUSED card; fires only for a card with an entry in `taskEvaluationById`. Absent ⇒ no-op. */
  readonly onOpenEvaluation?: (taskId: string) => void;
  /** Wall-clock seed for the idle ticker. Default `Date.now()` at render, which freezes the clock in isolated renders. */
  readonly nowMs?: number;
  /** Fired (deduped) when the focused card id changes; keeps the sidebar minimap highlight in sync. */
  readonly onFocusedCardChange?: (taskId: string | undefined) => void;
  /** Fired (deduped) when the focused card's expansion changes; the host claims `esc` while expanded so Esc collapses the card. */
  readonly onExpandedCardChange?: (expanded: boolean) => void;
  /**
   * Ids the host considers stuck (entity `status === 'blocked'`); gates the `u` chord, which fires
   * only for a FOCUSED card in this set. Independent of `bucketed.status` (presentation signal).
   * `TasksPanelHost` empties it while a run is live. Absent ⇒ empty.
   */
  readonly blockedTaskIds?: ReadonlySet<string>;
  /** `u` handler: revives the focused card's stuck task. Absent ⇒ no-op. */
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
 * Card-cursor and expansion state: which card is focused, which are expanded, and the
 * auto-expand-on-activation and focused-card reporting effects.
 */
const useTaskCardState = (
  bucketed: BucketedExecution,
  onFocusedCardChange: ((taskId: string | undefined) => void) | undefined,
  onExpandedCardChange: ((expanded: boolean) => void) | undefined
): TaskCardState => {
  // First in-flight task: anchor for the `e` hotkey and the default cursor. Settled-but-not-completed
  // buckets (failed / aborted / dependency-blocked) are BEHIND the cursor, or a task blocked
  // upstream would hold the anchor while later tasks run.
  const activeTaskIdx = bucketed.tasks.findIndex(isInFlightBucket);
  const activeTaskId = activeTaskIdx >= 0 ? bucketed.tasks[activeTaskIdx]?.id : undefined;

  // Settled-run anchor of last resort: a task stuck on either kind of block must not be windowed
  // off-screen behind an overflow cue when the run finishes. The own-failure case relies on the
  // caller having run `bucketed` through `overlayEntityBlockedStatus` (`TasksPanelHost` does).
  const firstBlockedIdx = bucketed.tasks.findIndex((t) => t.status === 'blocked');
  const firstBlockedId = bucketed.tasks[firstBlockedIdx]?.id;
  const lastTaskId = bucketed.tasks.at(-1)?.id;
  const settledFallbackId = firstBlockedId ?? lastTaskId;

  // The active task (or, settled, the fallback) starts expanded so the first paint already shows
  // the live stream; Esc / Enter collapse it like any other card.
  const [expandedTaskIds, setExpandedTaskIds] = useState<ReadonlySet<string>>(() => {
    const seedId = activeTaskId ?? settledFallbackId;
    return new Set(seedId !== undefined ? [seedId] : []);
  });
  // Index into `bucketed.tasks`; `undefined` = no manual focus yet, anchor on the active task.
  const [cardCursor, setCardCursor] = useState<number | undefined>(undefined);

  // Re-expand on active-task transitions (mount is handled by the initial state): the new active
  // task, or on settling the fallback, so the operator sees what needs attention or a summary.
  const [prevActiveTaskId, setPrevActiveTaskId] = useState(activeTaskId);
  if (prevActiveTaskId !== activeTaskId) {
    setPrevActiveTaskId(activeTaskId);
    const target = activeTaskId ?? settledFallbackId;
    if (target !== undefined) {
      setExpandedTaskIds((prev) => (prev.has(target) ? prev : new Set(prev).add(target)));
    }
  }

  const isCardExpanded = (taskId: string): boolean => expandedTaskIds.has(taskId);

  // Defaults to the active task; once settled, the first BLOCKED task (so it isn't windowed behind
  // an overflow cue), else the last card. Stays put across re-renders.
  const effectiveCardCursor = useMemo(() => {
    if (cardCursor !== undefined && cardCursor >= 0 && cardCursor < bucketed.tasks.length) return cardCursor;
    if (activeTaskIdx >= 0) return activeTaskIdx;
    if (firstBlockedIdx >= 0) return firstBlockedIdx;
    return bucketed.tasks.length - 1;
  }, [cardCursor, activeTaskIdx, firstBlockedIdx, bucketed.tasks.length]);
  const focusedCardId = effectiveCardCursor >= 0 ? bucketed.tasks[effectiveCardCursor]?.id : undefined;
  const focusedCardExpanded = focusedCardId !== undefined ? isCardExpanded(focusedCardId) : false;

  const reportFocusedCard = useEffectEvent((id: string | undefined) => onFocusedCardChange?.(id));
  const prevFocusedCardIdRef = useRef<string | undefined>(focusedCardId);
  useEffect(() => {
    if (focusedCardId !== prevFocusedCardIdRef.current) {
      prevFocusedCardIdRef.current = focusedCardId;
      reportFocusedCard(focusedCardId);
    }
  }, [focusedCardId]);

  // Unlike the focused-id report, the "previous" ref seeds `undefined` so the first post-mount run
  // always reports: the active task usually starts expanded, and the host needs that report to
  // claim `esc` before the operator's first keystroke.
  const reportExpanded = useEffectEvent((expanded: boolean) => onExpandedCardChange?.(expanded));
  const prevFocusedCardExpandedRef = useRef<boolean | undefined>(undefined);
  useEffect(() => {
    if (focusedCardExpanded !== prevFocusedCardExpandedRef.current) {
      prevFocusedCardExpandedRef.current = focusedCardExpanded;
      reportExpanded(focusedCardExpanded);
    }
  }, [focusedCardExpanded]);

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

/**
 * Merge one id-keyed source into the accumulating overlays. `toField` returns the overlay fragment
 * it contributes, or `undefined` for nothing (an empty criteria list stays absent, not an empty block).
 */
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

/**
 * Fold the host's parallel id-keyed maps into one `taskId → TaskOverlay` lookup, built once per
 * source change rather than per card per render. A task with no extras gets no entry and falls
 * back to {@link EMPTY_OVERLAY}.
 */
const buildOverlayByTaskId = (sources: TaskOverlaySources): ReadonlyMap<string, TaskOverlay> => {
  const overlays = new Map<string, TaskOverlay>();
  mergeOverlaySource(overlays, sources.recoveringByTaskId, (recovering) => ({ recovering }));
  mergeOverlaySource(overlays, sources.taskCriteriaById, (b) => (b.length > 0 ? { taskCriteria: b } : undefined));
  mergeOverlaySource(overlays, sources.blockedReasonById, (blockedReason) => ({ blockedReason }));
  mergeOverlaySource(overlays, sources.blockedTriageById, (blockedTriage) => ({ blockedTriage }));
  mergeOverlaySource(overlays, sources.priorWorkById, (priorWork) => ({ priorWork }));
  mergeOverlaySource(overlays, sources.warningSummaryById, (warningSummary) => ({ warningSummary }));
  mergeOverlaySource(overlays, sources.taskEvaluationById, (taskEvaluation) => ({ taskEvaluation }));
  mergeOverlaySource(overlays, sources.stepTreeByTaskId, (stepTree) => ({ stepTree }));
  // Keyed by id: the projection is stored by `order`, which needn't mirror the runtime sequence.
  const projections = new Map((sources.sprintState?.tasks ?? []).map((p) => [p.id, p]));
  mergeOverlaySource(overlays, projections, (taskProjection) => ({ taskProjection }));
  return overlays;
};

/** Render-derived values shared by every task row, bundled so {@link buildTaskRowProps} takes one argument. */
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

/** No Attempt iteration under the task's step tree yet; without a tree, no signal anywhere yet. */
const hasNoAttempt = (tree: StepView | undefined, noSignalsYet: boolean): boolean =>
  tree === undefined ? noSignalsYet : !tree.children.some((c) => c.iteration !== undefined);

/** Pure derivation of one `TaskBlock` row: absolute index, display name, signal slice bounds, overlay. */
const buildTaskRowProps = (task: TaskBucket, idx: number, derived: TaskRowDerived): TaskBlockProps => {
  // Stylistic 8-char short-uuid fallback (not a width clip); friendly names render verbatim.
  const display = derived.nameById?.get(task.id) ?? `${task.id.slice(0, 8)}${glyphs.clipEllipsis}`;
  const sliceLen = Math.min(task.signals.length, derived.maxSignalsPerTask);
  const sliceStart = task.signals.length - sliceLen;
  return {
    task,
    running: derived.running,
    display,
    maxSignals: derived.maxSignalsPerTask,
    maxSubSteps: derived.maxSubSteps,
    focusedKey: derived.effectiveFocusedKey,
    expandedKeys: derived.expandedKeys,
    scopeId: task.id,
    sliceStart,
    criteriaExpanded: derived.criteriaExpandedIds.has(task.id),
    isActive: idx === derived.activeTaskIdx,
    firstRun: hasNoAttempt(derived.overlayByTaskId.get(task.id)?.stepTree, derived.noSignalsYet),
    cardExpanded: derived.isCardExpanded(task.id),
    cardFocused: idx === derived.effectiveCardCursor,
    nowMs: derived.effectiveNowMs,
    overlay: derived.overlayByTaskId.get(task.id) ?? EMPTY_OVERLAY,
  };
};

/**
 * The windowed run of task cards: keeping the active / focused card visible caps the rendered
 * count at the terminal-derived budget. Absent `maxTasks` means no cap.
 */
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
        // `isActive` / `cardFocused` compare absolute indices.
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

/**
 * Memoized {@link buildOverlayByTaskId}, keyed on the individual source maps (the `sources` bag is
 * a fresh rest-object every render) so a card's `overlay` keeps its reference and `TaskBlock` memo.
 */
const useTaskOverlays = (sources: TaskOverlaySources): ReadonlyMap<string, TaskOverlay> =>
  useMemo(
    () => buildOverlayByTaskId(sources),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `sources` is a new object every render; its maps are the real inputs.
    [
      sources.recoveringByTaskId,
      sources.taskCriteriaById,
      sources.blockedReasonById,
      sources.blockedTriageById,
      sources.warningSummaryById,
      sources.priorWorkById,
      sources.taskEvaluationById,
      sources.stepTreeByTaskId,
      sources.sprintState,
    ]
  );

/** Cross-task notes shown while a task is active. */
const ACTIVE_ORPHAN_ROWS = 2;

/** Stable empty-set reference for the `blockedTaskIds` default — never recreated per render. */
const NO_BLOCKED_TASK_IDS: ReadonlySet<string> = new Set();

/** Bundles the first-run flag, the orphan-signal slice offset and the {@link TaskRowDerived} record every card reads. */
const buildRenderDerived = (
  bucketed: BucketedExecution,
  maxOrphanSignals: number,
  cardState: TaskCardState,
  rowSettings: Omit<TaskRowDerived, keyof TaskCardState | 'noSignalsYet'>
): { readonly orphanSliceStart: number; readonly derived: TaskRowDerived } => {
  // Tasks exist but no harness signal has fired yet: the active card shows `waiting for first attempt…`.
  const noSignalsYet =
    bucketed.orphanSignals.length === 0 &&
    bucketed.tasks.every((t) => t.signals.length === 0 && t.evaluations.length === 0);
  const orphanSliceStart = bucketed.orphanSignals.length - Math.min(bucketed.orphanSignals.length, maxOrphanSignals);
  return { orphanSliceStart, derived: { ...cardState, ...rowSettings, noSignalsYet } };
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
  const effectiveNowMs = nowMs ?? Date.now();
  // While a task runs, cross-task notes yield rows to its step tree.
  const orphanMax = bucketed.tasks.some((t) => t.status === 'running')
    ? Math.min(maxOrphanSignals, ACTIVE_ORPHAN_ROWS)
    : maxOrphanSignals;
  const flatKeys = useMemo(
    () => buildFlatFocusKeys(bucketed, maxSignalsPerTask, orphanMax),
    [bucketed, maxSignalsPerTask, orphanMax]
  );

  // Cursor identity is the focused row's stable key, so it sticks to its row as new signals shift
  // indices; if the key falls off the visible slice it collapses to `undefined` and Enter/Space re-anchors.
  const [focusedKey, setFocusedKey] = useState<string | undefined>(undefined);
  const [expandedKeys, setExpandedKeys] = useState<ReadonlySet<string>>(() => new Set<string>());
  // Task ids whose criteria block shows the full bullet list (default: 3-line summary); toggled by `e`.
  const [criteriaExpandedIds, setCriteriaExpandedIds] = useState<ReadonlySet<string>>(() => new Set());

  const overlayByTaskId = useTaskOverlays(overlaySources);

  const cardState = useTaskCardState(bucketed, onFocusedCardChange, onExpandedCardChange);

  const focusedIndex = focusedKey !== undefined ? flatKeys.indexOf(focusedKey) : -1;
  const effectiveFocusedKey = focusedIndex >= 0 ? focusedKey : undefined;

  // Task ids `v` may open: those with a recorded verdict, so `v` on an unevaluated card falls through.
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
  const { orphanSliceStart, derived } = buildRenderDerived(bucketed, orphanMax, cardState, {
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
        max={orphanMax}
        focusedKey={effectiveFocusedKey}
        expandedKeys={expandedKeys}
        sliceStart={orphanSliceStart}
      />
      <TaskCards tasks={bucketed.tasks} maxTasks={maxTasks} derived={derived} />
    </Box>
  );
};
