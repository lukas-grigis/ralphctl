/**
 * Tasks panel — per-task view of an Implement run. Each task block renders:
 *
 *   ✓ <id-short> · <duration> · <status>
 *     ↳ <sub-step name>          <duration>
 *     …
 *     eval passed · attempt 2
 *     signals
 *       09:19  chng  added canvas-confetti …
 *       09:19  lern  useLocation + global side-effect …
 *       09:19  cmsg  feat(web-ui): add confetti …
 *
 * Cross-task signals (those whose timestamp doesn't fall inside any task window) pin at the top
 * as "Cross-task notes" so notes-about-the-run aren't lost.
 *
 * Correlation lives in `bucket-task-signals.ts`; this component is a pure renderer over the
 * bucketed structure. Internals are split under `tasks-panel-internals/` — row renderers, the
 * evaluation row, the keyboard model, the focus-key plumbing, and the pure format helpers all
 * live next door so this file can stay a small orchestrator.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import type { BucketedExecution, TaskBucket } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import type { SprintState, TaskOverlay } from '@src/application/ui/tui/components/tasks-projection.ts';
import type { TaskEvaluation } from '@src/application/ui/tui/components/tasks-panel-internals/evaluation-row.tsx';
import type { RecoveryContext } from '@src/domain/entity/attempt.ts';
import { glyphs, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { computeListWindow, OverflowRow } from '@src/application/ui/tui/components/windowed-list.tsx';
import { collectKinds, InlineKindsBar } from '@src/application/ui/tui/components/tasks-panel-internals/signal-rows.tsx';
import { TaskBlock } from '@src/application/ui/tui/components/tasks-panel-internals/task-row.tsx';
import { OrphanSignals } from '@src/application/ui/tui/components/tasks-panel-internals/orphan-signals.tsx';
import { buildFlatFocusKeys } from '@src/application/ui/tui/components/tasks-panel-internals/focus-keys.ts';
import { useTasksPanelInput } from '@src/application/ui/tui/components/tasks-panel-internals/keymap.ts';

export { SIGNAL_LABEL_COLOR } from '@src/application/ui/tui/components/tasks-panel-internals/signal-rows.tsx';

/**
 * The per-task extras the host view supplies as parallel id-keyed maps. They arrive separately
 * because each is derived from a different source (the session descriptor, the polled task
 * entities, the planned-leaf list, the sprint projection), but the panel immediately folds them
 * into one {@link TaskOverlay} per task so a card looks its extras up once.
 */
interface TaskOverlaySources {
  /**
   * Optional `taskId → RecoveryContext` map for tasks the launcher detected as resuming a
   * prior aborted attempt. When set for a given task id the active-task header gets a second
   * row: `↳ attempt N · resumed from aborted M at HH:MM (CAUSE)`. Absent / empty when no
   * task in the run is a resume.
   */
  readonly recoveringByTaskId?: ReadonlyMap<string, RecoveryContext>;
  /**
   * Map of task id → `verificationCriteria` bullets, sourced directly from `Task.verificationCriteria`
   * by the host view (no disk read, no async loader). When supplied, each non-pending task's
   * header renders a collapsed 3-line summary of the criteria with a `press e to expand` hint;
   * pressing `e` while the panel owns input toggles the active task's full criteria block.
   */
  readonly taskCriteriaById?: ReadonlyMap<string, readonly string[]>;
  /**
   * Optional `taskId → blockedReason` map sourced from the polled task entities. When a task is
   * blocked, its reason renders under the card header so the operator sees WHY (own failure vs
   * `blocked upstream — …`) rather than a bare `blocked` status. Absent for runs with no blocks.
   */
  readonly blockedReasonById?: ReadonlyMap<string, string>;
  /**
   * Optional `taskId → warning summary` map sourced from the polled task entities. When a task
   * settled `done` but its FINAL attempt carries an `AttemptWarning`, its one-line summary renders
   * under the card header with the warning glyph so a flagged completion never reads as a clean
   * pass. Absent for runs whose done tasks are all clean.
   */
  readonly warningSummaryById?: ReadonlyMap<string, string>;
  /**
   * Optional `taskId → authoritative evaluation verdict` map sourced from the polled task
   * entities (the LAST attempt's `evaluation.status`, keyed by task id). The card renders THIS
   * verdict — never the timestamp-bucketed `TaskBucket.evaluations` signal stream, which mis-
   * attributes evaluator signals to the wrong task under parallel/wave sprints (overlapping
   * windows + AI-fabricated timestamps). Absent / no key for a task ⇒ "awaiting eval" while the
   * card is active, or no verdict line otherwise.
   */
  readonly taskEvaluationById?: ReadonlyMap<string, TaskEvaluation>;
  /**
   * Optional `taskId → pending leaf names` map for upcoming (not-yet-run) sub-steps.
   * Derived from `descriptor.plannedLeaves` by filtering to UUID-suffixed entries for each
   * task id and subtracting already-executed leaves. Rendered as grey `◇` rows below the
   * executed sub-steps so the operator sees the planned flow ahead, matching the Steps rail.
   *
   * Only FIXED surrounding leaves are included — dynamic generator/evaluator round-leaves are
   * excluded so the pending list doesn't imply a fixed round count.
   *
   * Absent when `descriptor.plannedLeaves` is not available.
   */
  readonly pendingSubStepsByTaskId?: ReadonlyMap<string, readonly string[]>;
  /**
   * Optional projected sprint state. When supplied the per-task header appends an ETA derived
   * from `state.tasks[i].medianRoundDurationMs * (max - currentRound)`. Absent ⇒ ETA is
   * silently omitted (the existing `round N/M` rendering is unchanged). The view is the source
   * of truth for whether to project: tests render TasksPanel in isolation without a projection,
   * and the live dashboard threads it once `taskState` is polled.
   *
   * Stored by `order`, so entries are matched onto bucketed tasks by id rather than position.
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
  /**
   * Optional card-count budget for the task list. When supplied and the run has more tasks than
   * this, the panel renders an anchored window of `maxTasks` cards centred on the active /
   * focused card (so the live work stays visible) and shows dim "▴ N more above" / "▾ N more
   * below" cues for the hidden remainder. Without it the column grew unbounded with 3-4+ tasks
   * and pushed the Recent-log + footer off-screen. Defaults to unbounded (every card rendered)
   * so isolated unit renders are unchanged — the Execute view threads `layout.tasksMaxBlocks`.
   */
  readonly maxTasks?: number;
  /** Max orphan signals to render. */
  readonly maxOrphanSignals?: number;
  /**
   * When `true` the panel claims keyboard input for row-cursor navigation (j/k or ↑/↓) and
   * row expansion (Enter / Space). Defaults to `false` so unit tests that render the panel in
   * isolation don't compete with any other `useInput` handler in the same Ink tree. The
   * Implement view sets this `true` while the run is live and no overlay is open.
   *
   * The cursor traverses the flat sequence of visible signal rows (orphans first, then each
   * task in order). When focused on a `commit-message` row, Enter / Space toggles expansion to
   * reveal the body. The subject row shows the AI-proposed subject; the harness-appended
   * ` (#123, !456)` ref suffix lands at `git commit -F` time and is not threaded back onto the
   * signal. Expansion state lives in panel-local
   * `useState` so it persists across re-renders within the session but resets if the panel
   * unmounts (e.g. on `D` detach back to home).
   */
  readonly inputActive?: boolean;
  /**
   * Max sub-step rows per task to render; older ones drop off the top behind a single elision
   * row. Bounds Ink reconciliation cost on long gen-eval loops (every retry adds ~12 leaves),
   * preventing the OOM mode where unbounded child lists thrash the V8 heap every spinner tick.
   */
  readonly maxSubStepsPerTask?: number;
  /**
   * Dev-only flag — when `true`, failing evaluator rows render via
   * `<EvaluatorFailurePanel>` (per-dimension colour-coded view + critique excerpt with
   * expand affordance) instead of the canonical single-line summary. Defaults `false` so
   * production keeps the existing 4-line dimension summary until the per-dimension panel is
   * promoted out of the developer-flag gate. Threaded from `settings.developer
   * .showEvaluatorFailureUI` by the launcher.
   */
  readonly showEvaluatorFailureUI?: boolean;
  /**
   * Wall-clock reference in milliseconds — used by the idle-ticker to compute the gap between
   * the latest stream signal and "now". The execute view polls every 1s and passes the latest
   * `Date.now()`; tests pass a fixed value. Defaults to `Date.now()` at render-time so
   * isolated unit renders work without explicit wiring (no ticker fires without elapsed gap).
   */
  readonly nowMs?: number;
  /**
   * Optional callback fired when the panel's focused card id changes (deduplicated — only called
   * when the id value is different from the previous call). The sidebar minimap uses this to keep
   * its highlight in sync with the main-area cursor without owning any input itself. Absent ⇒
   * the panel is fully self-contained (existing callers are unaffected).
   */
  readonly onFocusedCardChange?: (taskId: string | undefined) => void;
  /**
   * Optional callback fired when the focused card's expansion state changes (deduplicated —
   * only called when the boolean value differs from the previous call). The wide-layout
   * `ImplementMainArea` uses this to claim the `esc` keystroke (via `useUiState().claimEscape()`)
   * while an expanded card is focused, so pressing Esc collapses the card instead of popping the
   * route. Absent ⇒ the panel is fully self-contained (existing callers are unaffected).
   */
  readonly onExpandedCardChange?: (expanded: boolean) => void;
}

interface TaskCardState {
  /** Index of the first non-completed task in `bucketed.tasks`; `-1` when every task is done. */
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
 * Card-cursor / expansion state cluster for the Tasks panel — which card is focused, which
 * cards are expanded, and the auto-expand-on-activation + focused-card-change side effects.
 * Extracted from `TasksPanel` (mirrors the `useTasksPanelInput` split next door) so the render
 * body only has to thread the resulting values, not own the effects that produce them.
 */
const useTaskCardState = (
  bucketed: BucketedExecution,
  onFocusedCardChange: ((taskId: string | undefined) => void) | undefined,
  onExpandedCardChange: ((expanded: boolean) => void) | undefined
): TaskCardState => {
  // The active (first non-completed) task — anchor for the `e` criteria hotkey AND the
  // default card-cursor position. Recomputed each render so the `useInput` callback always
  // sees the latest active id.
  const activeTaskIdx = bucketed.tasks.findIndex((t) => t.status !== 'completed');
  const activeTaskId = activeTaskIdx >= 0 ? bucketed.tasks[activeTaskIdx]?.id : undefined;

  // Per-task card expansion. The active (running) task auto-expands when it becomes active so
  // the operator's eye anchors on the live stream — but the user can collapse it with Esc or
  // Enter just like any other card. Other cards default collapsed to a one-line summary.
  // Initial state seeds the active task on mount so the very first paint already shows the
  // live stream (no `useEffect`-induced flicker).
  // REQ-3 edge case: when ALL tasks are completed, activeTaskId is undefined — seed with the
  // last task so the operator sees a non-empty expanded card on first render.
  const lastTaskId = bucketed.tasks.length > 0 ? bucketed.tasks[bucketed.tasks.length - 1]?.id : undefined;
  const seedId = activeTaskId ?? lastTaskId;
  const [expandedTaskIds, setExpandedTaskIds] = useState<ReadonlySet<string>>(
    () => new Set(seedId !== undefined ? [seedId] : [])
  );
  // Card cursor — index into `bucketed.tasks`. Default `undefined` means "no manual focus
  // yet"; the panel anchors on the active task on first interaction.
  const [cardCursor, setCardCursor] = useState<number | undefined>(undefined);

  // Seed `expandedTaskIds` with the active task whenever it transitions to a new id (post-mount
  // transitions only — mount itself is handled by the lazy initial state). This gives the
  // auto-expand-on-activation UX without making the expansion permanent: once the active id is
  // in the set, Esc / Enter on it works the same as on any manually-expanded card.
  // REQ-3: when the run transitions to all-completed (activeTaskId becomes undefined), ensure
  // the last task card remains expanded so the operator sees a completion summary.
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
    } else if (activeTaskId === undefined && prevId !== undefined && lastTaskId !== undefined) {
      // Transitioned to all-completed — expand the last task as the completion summary.
      setExpandedTaskIds((prev) => {
        if (prev.has(lastTaskId)) return prev;
        const next = new Set(prev);
        next.add(lastTaskId);
        return next;
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- lastTaskId is derived from bucketed.tasks; re-running on every task append would fight the guard (prevId check ensures we only act on activeTaskId transitions, not task additions).
  }, [activeTaskId]);

  const isCardExpanded = (taskId: string): boolean => expandedTaskIds.has(taskId);

  // The card cursor — defaults to the active task on first render, falls back to the last
  // card when the active task no longer exists (e.g. the run has finished). Stays put across
  // re-renders so a moving cursor doesn't jump.
  const effectiveCardCursor = useMemo(() => {
    if (cardCursor !== undefined && cardCursor >= 0 && cardCursor < bucketed.tasks.length) return cardCursor;
    if (activeTaskIdx >= 0) return activeTaskIdx;
    return bucketed.tasks.length - 1;
  }, [cardCursor, activeTaskIdx, bucketed.tasks.length]);
  const focusedCardId = effectiveCardCursor >= 0 ? bucketed.tasks[effectiveCardCursor]?.id : undefined;
  const focusedCardExpanded = focusedCardId !== undefined ? isCardExpanded(focusedCardId) : false;

  // Report focused card id upward (passive sidebar minimap). Deduped — only fires when the id
  // changes. Uses a ref for the callback so a non-memoised caller doesn't cause an extra effect
  // run on every render; the ref is kept current on every render before the effect fires.
  const prevFocusedCardIdRef = useRef<string | undefined>(focusedCardId);
  const onFocusedCardChangeRef = useRef(onFocusedCardChange);
  onFocusedCardChangeRef.current = onFocusedCardChange;
  useEffect(() => {
    if (focusedCardId !== prevFocusedCardIdRef.current) {
      prevFocusedCardIdRef.current = focusedCardId;
      onFocusedCardChangeRef.current?.(focusedCardId);
    }
  });

  // Report the focused card's expansion state upward (Esc-claim seam). Same dedup + ref
  // pattern as `onFocusedCardChange` above, with one deliberate difference: the "previous"
  // ref seeds as `undefined` (not the current value) so the FIRST post-mount effect run always
  // reports the mount-time state. The active task auto-expands from the lazy initial state (see
  // above), so `focusedCardExpanded` is frequently already `true` on the very first render —
  // seeding the ref with that same value (as `onFocusedCardChange` does) would suppress the one
  // report the caller needs to claim `esc` before the operator's first keystroke.
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

/**
 * Merge one id-keyed source into the accumulating overlays. `toField` turns a source value into
 * the overlay fragment it contributes, or `undefined` when it contributes nothing — which is how
 * an empty criteria / pending-sub-step list stays absent rather than rendering an empty block.
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
 * Fold the host's parallel id-keyed maps into one `taskId → TaskOverlay` lookup. Built once per
 * change of the source maps rather than once per card per render, which also turns the sprint
 * projection from a linear scan per card into a single keyed pass.
 *
 * The key set is the union of the sources' keys — a task with no extras never gets an entry and
 * falls back to {@link EMPTY_OVERLAY} at lookup time.
 */
const buildOverlayByTaskId = (sources: TaskOverlaySources): ReadonlyMap<string, TaskOverlay> => {
  const overlays = new Map<string, TaskOverlay>();
  mergeOverlaySource(overlays, sources.recoveringByTaskId, (recovering) => ({ recovering }));
  mergeOverlaySource(overlays, sources.taskCriteriaById, (b) => (b.length > 0 ? { taskCriteria: b } : undefined));
  mergeOverlaySource(overlays, sources.blockedReasonById, (blockedReason) => ({ blockedReason }));
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
 * Render-derived values shared by every row this render — the card-cursor/expansion state
 * (via `useTaskCardState`), the folded per-task overlays, and the panel-level settings each card
 * needs, bundled so {@link buildTaskRowProps} takes one argument instead of a dozen positional ones.
 */
interface TaskRowDerived {
  readonly running: boolean;
  readonly nameById: ReadonlyMap<string, string> | undefined;
  readonly maxSubSteps: number;
  readonly showEvaluatorFailureUI: boolean;
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
 * Pure per-task derivation for one `TaskBlock` row — absolute index, display name, the signal
 * slice bounds, and this task's overlay.
 */
const buildTaskRowProps = (task: TaskBucket, idx: number, derived: TaskRowDerived): TaskBlockProps => {
  // Deliberate stylistic 8-char short-uuid fallback (NOT a width-driven clip) — keeps
  // the header readable when the launcher hasn't supplied a friendly name. The friendly
  // name path goes through `nameById` and renders verbatim; if a future design makes
  // the name itself overflow, wrap that path in a `<Box flexGrow>` + `wrap="truncate-end"`.
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
    showEvaluatorFailureUI: derived.showEvaluatorFailureUI,
    isActive: idx === derived.activeTaskIdx,
    firstRun: derived.noSignalsYet,
    cardExpanded: derived.isCardExpanded(task.id),
    cardFocused: idx === derived.effectiveCardCursor,
    nowMs: derived.effectiveNowMs,
    overlay: derived.overlayByTaskId.get(task.id) ?? EMPTY_OVERLAY,
  };
};

/**
 * The windowed run of task cards. Keeping the active / focused card visible caps the rendered card
 * count at the terminal-derived budget so the column stops growing past the viewport; an absent
 * `maxTasks` means "no cap", preserving isolated-render behaviour (`computeListWindow` treats a
 * non-positive budget the same way, so an explicit `0` degrades identically).
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

/**
 * Memoized {@link buildOverlayByTaskId}. Keyed on the individual source maps rather than the
 * `sources` bag, which is a fresh rest-object on every render — so a card's `overlay` prop keeps
 * its reference (and with it the `TaskBlock` memo bail-out) until a source map actually changes.
 */
const useTaskOverlays = (sources: TaskOverlaySources): ReadonlyMap<string, TaskOverlay> =>
  useMemo(
    () => buildOverlayByTaskId(sources),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see the docstring: `sources` itself is a new object identity every render; its maps are the real inputs.
    [
      sources.recoveringByTaskId,
      sources.taskCriteriaById,
      sources.blockedReasonById,
      sources.warningSummaryById,
      sources.taskEvaluationById,
      sources.pendingSubStepsByTaskId,
      sources.sprintState,
    ]
  );

export const TasksPanel = ({
  bucketed,
  running,
  nameById,
  maxSignalsPerTask = 8,
  maxTasks,
  maxOrphanSignals = 6,
  inputActive = false,
  maxSubStepsPerTask = 12,
  showEvaluatorFailureUI = false,
  nowMs,
  onFocusedCardChange,
  onExpandedCardChange,
  ...overlaySources
}: TasksPanelProps): React.JSX.Element => {
  // Render-time fallback for the idle-ticker clock. The execute view passes a polled `now` so
  // the ticker can re-evaluate on each heartbeat; isolated unit renders fall through to this
  // default, which freezes the clock at mount-time and so naturally suppresses the ticker
  // unless a test explicitly supplies an old timestamp.
  const effectiveNowMs = nowMs ?? Date.now();
  const flatKeys = useMemo(
    () => buildFlatFocusKeys(bucketed, maxSignalsPerTask, maxOrphanSignals),
    [bucketed, maxSignalsPerTask, maxOrphanSignals]
  );

  // Cursor identity is the focused row's stable key (not its index). When a new signal lands
  // the index of the existing row may shift, but its key is unchanged, so the cursor sticks
  // to the same row. When the focused key falls off the visible slice (cap-elision), the
  // cursor collapses to `undefined` and Enter/Space re-anchors at the latest row.
  const [focusedKey, setFocusedKey] = useState<string | undefined>(undefined);
  const [expandedKeys, setExpandedKeys] = useState<ReadonlySet<string>>(() => new Set<string>());
  // No lazy hydration — `taskCriteriaById` is supplied synchronously by the host view from
  // `Task.verificationCriteria`. Empty array → render the placeholder; missing key (task not
  // yet in view's poll) → criteria UI is suppressed for that task.
  // Task ids whose criteria block is currently expanded (full bullet list). Default state is
  // the 3-line summary. Toggled by pressing `e` while the panel owns input.
  const [criteriaExpandedIds, setCriteriaExpandedIds] = useState<ReadonlySet<string>>(() => new Set());

  // One folded `taskId → TaskOverlay` lookup replacing the host's parallel maps — see
  // `buildOverlayByTaskId`.
  const overlayByTaskId = useTaskOverlays(overlaySources);

  // Card-cursor / expansion state — see `useTaskCardState`. Spread wholesale below (into both
  // `useTasksPanelInput` and `derived`) rather than destructured field-by-field so this
  // orchestrator stays a thin threading layer instead of re-enumerating the cluster's shape.
  const cardState = useTaskCardState(bucketed, onFocusedCardChange, onExpandedCardChange);

  const focusedIndex = focusedKey !== undefined ? flatKeys.indexOf(focusedKey) : -1;
  const effectiveFocusedKey = focusedIndex >= 0 ? focusedKey : undefined;

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
    ...cardState,
  });

  if (bucketed.tasks.length === 0 && bucketed.orphanSignals.length === 0) {
    return <EmptyTasksPanel />;
  }
  // First-run state — tasks exist but no harness signal has fired yet across the whole run.
  // The kinds bar is suppressed (it's already empty when no signals are present) and the
  // active-task block shows a `waiting for first attempt…` line below the spinner. Computed
  // here so `TaskBlock` can pick it up via a single prop.
  const noSignalsYet =
    bucketed.orphanSignals.length === 0 &&
    bucketed.tasks.every((t) => t.signals.length === 0 && t.evaluations.length === 0);
  const orphanSliceStart = bucketed.orphanSignals.length - Math.min(bucketed.orphanSignals.length, maxOrphanSignals);
  const derived: TaskRowDerived = {
    ...cardState,
    running,
    nameById,
    maxSubSteps: maxSubStepsPerTask,
    showEvaluatorFailureUI,
    overlayByTaskId,
    effectiveFocusedKey,
    expandedKeys,
    criteriaExpandedIds,
    noSignalsYet,
    effectiveNowMs,
    maxSignalsPerTask,
  };
  return (
    <Box flexDirection="column" paddingX={spacing.indent}>
      <InlineKindsBar kinds={collectKinds(bucketed)} />
      <OrphanSignals
        signals={bucketed.orphanSignals}
        max={maxOrphanSignals}
        focusedKey={effectiveFocusedKey}
        expandedKeys={expandedKeys}
        sliceStart={orphanSliceStart}
      />
      <TaskCards tasks={bucketed.tasks} maxTasks={maxTasks} derived={derived} />
    </Box>
  );
};
