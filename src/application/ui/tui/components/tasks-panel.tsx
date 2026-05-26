/**
 * Tasks panel — per-task view of an Implement run. Each task block renders:
 *
 *   ✓ <id-short> · <duration> · <status>
 *     ↳ <sub-step name>          <duration>
 *     …
 *     eval passed  5.0/5.0
 *     correctness: 5/5 ✓  completeness: 5/5 ✓  …
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
import type { BucketedExecution } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import type { SprintState, TaskProjection } from '@src/application/ui/tui/components/tasks-projection.ts';
import type { RecoveryContext } from '@src/domain/entity/attempt.ts';
import { glyphs, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { InlineKindsBar, collectKinds } from '@src/application/ui/tui/components/tasks-panel-internals/signal-rows.tsx';
import { OrphanSignals, TaskBlock } from '@src/application/ui/tui/components/tasks-panel-internals/task-row.tsx';
import { buildFlatFocusKeys } from '@src/application/ui/tui/components/tasks-panel-internals/focus-keys.ts';
import { useTasksPanelInput } from '@src/application/ui/tui/components/tasks-panel-internals/keymap.ts';

export { SIGNAL_LABEL_COLOR } from '@src/application/ui/tui/components/tasks-panel-internals/signal-rows.tsx';

export interface TasksPanelProps {
  readonly bucketed: BucketedExecution;
  readonly running: boolean;
  /** Optional id → friendly name. Falls back to first 8 chars of the id. */
  readonly nameById?: ReadonlyMap<string, string>;
  /** Max signals per task to render; older ones drop off the top. */
  readonly maxSignalsPerTask?: number;
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
  /** Max evaluation rows per task to render; same elision treatment as sub-steps. */
  readonly maxEvaluationsPerTask?: number;
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
   *
   * Audit [05]: replaces the prior `readDoneCriteria` lazy loader that read from a now-deleted
   * `<sprintDir>/implement/<task-id>/done-criteria.md`. The criteria live on the task entity,
   * the view already polls those entities, and the file is gone.
   */
  readonly taskCriteriaById?: ReadonlyMap<string, readonly string[]>;
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
   * Optional projected sprint state. When supplied the per-task header appends an ETA derived
   * from `state.tasks[i].medianRoundDurationMs * (max - currentRound)`. Absent ⇒ ETA is
   * silently omitted (the existing `round N/M` rendering is unchanged). The view is the source
   * of truth for whether to project: tests render TasksPanel in isolation without a projection,
   * and the live dashboard threads it once `taskState` is polled.
   */
  readonly sprintState?: SprintState;
  /**
   * Wall-clock reference in milliseconds — used by the idle-ticker to compute the gap between
   * the latest stream signal and "now". The execute view polls every 1s and passes the latest
   * `Date.now()`; tests pass a fixed value. Defaults to `Date.now()` at render-time so
   * isolated unit renders work without explicit wiring (no ticker fires without elapsed gap).
   */
  readonly nowMs?: number;
}

export const TasksPanel = ({
  bucketed,
  running,
  nameById,
  maxSignalsPerTask = 8,
  maxOrphanSignals = 6,
  maxSubStepsPerTask = 12,
  maxEvaluationsPerTask = 6,
  recoveringByTaskId,
  inputActive = false,
  taskCriteriaById,
  showEvaluatorFailureUI = false,
  sprintState,
  nowMs,
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
  const [expandedTaskIds, setExpandedTaskIds] = useState<ReadonlySet<string>>(
    () => new Set(activeTaskId !== undefined ? [activeTaskId] : [])
  );
  // Card cursor — index into `bucketed.tasks`. Default `undefined` means "no manual focus
  // yet"; the panel anchors on the active task on first interaction.
  const [cardCursor, setCardCursor] = useState<number | undefined>(undefined);

  // Seed `expandedTaskIds` with the active task whenever it transitions to a new id (post-mount
  // transitions only — mount itself is handled by the lazy initial state). This gives the
  // auto-expand-on-activation UX without making the expansion permanent: once the active id is
  // in the set, Esc / Enter on it works the same as on any manually-expanded card.
  const prevActiveTaskIdRef = useRef<string | undefined>(activeTaskId);
  useEffect(() => {
    if (activeTaskId !== undefined && prevActiveTaskIdRef.current !== activeTaskId) {
      setExpandedTaskIds((prev) => {
        if (prev.has(activeTaskId)) return prev;
        const next = new Set(prev);
        next.add(activeTaskId);
        return next;
      });
    }
    prevActiveTaskIdRef.current = activeTaskId;
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

  const focusedIndex = focusedKey !== undefined ? flatKeys.indexOf(focusedKey) : -1;
  const effectiveFocusedKey = focusedIndex >= 0 ? focusedKey : undefined;

  useTasksPanelInput({
    inputActive,
    bucketed,
    flatKeys,
    focusedKey,
    focusedIndex,
    effectiveFocusedKey,
    effectiveCardCursor,
    focusedCardId,
    focusedCardExpanded,
    activeTaskId,
    expandedTaskIds,
    setFocusedKey,
    setExpandedKeys,
    setCardCursor,
    setExpandedTaskIds,
    setCriteriaExpandedIds,
  });

  if (bucketed.tasks.length === 0 && bucketed.orphanSignals.length === 0) {
    return (
      <Box paddingX={spacing.indent}>
        <Text dimColor>
          {glyphs.bullet} Tasks panel empty {glyphs.bullet} Run plan to generate tasks
        </Text>
      </Box>
    );
  }
  // First-run state — tasks exist but no harness signal has fired yet across the whole run.
  // The kinds bar is suppressed (it's already empty when no signals are present) and the
  // active-task block shows a `waiting for first attempt…` line below the spinner. Computed
  // here so `TaskBlock` can pick it up via a single prop.
  const noSignalsYet =
    bucketed.orphanSignals.length === 0 &&
    bucketed.tasks.every((t) => t.signals.length === 0 && t.evaluations.length === 0);
  const kinds = collectKinds(bucketed);
  const orphanSliceLen = Math.min(bucketed.orphanSignals.length, maxOrphanSignals);
  const orphanSliceStart = bucketed.orphanSignals.length - orphanSliceLen;
  return (
    <Box flexDirection="column" paddingX={spacing.indent}>
      <InlineKindsBar kinds={kinds} />
      <OrphanSignals
        signals={bucketed.orphanSignals}
        max={maxOrphanSignals}
        focusedKey={effectiveFocusedKey}
        expandedKeys={expandedKeys}
        sliceStart={orphanSliceStart}
      />
      {bucketed.tasks.map((task, idx) => {
        // Deliberate stylistic 8-char short-uuid fallback (NOT a width-driven clip) — keeps
        // the header readable when the launcher hasn't supplied a friendly name. The friendly
        // name path goes through `nameById` and renders verbatim; if a future design makes
        // the name itself overflow, wrap that path in a `<Box flexGrow>` + `wrap="truncate-end"`.
        const display = nameById?.get(task.id) ?? `${task.id.slice(0, 8)}${glyphs.clipEllipsis}`;
        const recovering = recoveringByTaskId?.get(task.id);
        const sliceLen = Math.min(task.signals.length, maxSignalsPerTask);
        const sliceStart = task.signals.length - sliceLen;
        // Read criteria synchronously from props (audit [05]). Empty arrays / missing keys
        // suppress the block entirely; non-empty arrays drive both the collapsed summary and
        // the per-criterion verdict alignment with evaluator dimensions.
        const criteriaBullets = taskCriteriaById?.get(task.id);
        const taskCriteria = criteriaBullets !== undefined && criteriaBullets.length > 0 ? criteriaBullets : undefined;
        // Match by id when a projection is supplied so the order of `sprintState.tasks`
        // doesn't have to mirror the bucketed order (projections are stored by `order`; bucketed
        // tasks track the runtime sequence).
        const taskProjection = sprintState?.tasks.find((t: TaskProjection) => t.id === task.id);
        const isActive = idx === activeTaskIdx;
        return (
          <TaskBlock
            key={task.id}
            task={task}
            running={running}
            display={display}
            maxSignals={maxSignalsPerTask}
            maxSubSteps={maxSubStepsPerTask}
            maxEvaluations={maxEvaluationsPerTask}
            focusedKey={effectiveFocusedKey}
            expandedKeys={expandedKeys}
            scopeId={task.id}
            sliceStart={sliceStart}
            criteriaExpanded={criteriaExpandedIds.has(task.id)}
            showEvaluatorFailureUI={showEvaluatorFailureUI}
            isActive={isActive}
            firstRun={noSignalsYet}
            cardExpanded={isCardExpanded(task.id)}
            cardFocused={idx === effectiveCardCursor}
            nowMs={effectiveNowMs}
            {...(recovering !== undefined ? { recovering } : {})}
            {...(taskCriteria !== undefined ? { taskCriteria } : {})}
            {...(taskProjection !== undefined ? { taskProjection } : {})}
          />
        );
      })}
    </Box>
  );
};
