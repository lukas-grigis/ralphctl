/**
 * View-hint registration + keyboard handling for the execute view.
 *
 * Hints adapt to three states:
 *   - running + cancel-scope picker open: `1 / 2 / esc` set
 *   - running, picker closed              : `c / D` set
 *   - not running                         : `↵ home · r re-run · g progress`
 *
 * Key handling:
 *   - help / prompt overlays own the keyboard — early-return when active.
 *   - while running: `c` opens the cancel-scope picker (unless already open); `D` detaches
 *     to Home (router.reset, runner continues in background). `r` is deliberately inert here —
 *     a stray keystroke must not navigate off a live run.
 *   - when settled: Enter / Esc resets to Home. ALWAYS Home — never sprint-detail or a
 *     stack pop. A finished flow (refine / plan / implement / …) drops the user back on the
 *     Home card with their own project/sprint selection intact. Browsing a run must not
 *     decide where the user "is".
 *   - when settled: `r` resets to Flows. It overlaps the global `n` on destination only —
 *     `n` PUSHES, leaving the dead run on the stack for `esc` to fall back into, whereas the
 *     reset drops it. Flows then re-evaluates every launch trigger against the sprint's
 *     CURRENT status, so a sprint that moved review → done during the run offers create-pr
 *     rather than a stale re-launch of what just ran.
 *   - `g` (progress overlay) has NO handler here on purpose: it is a global chord owned by
 *     `use-global-keys.ts`, and its open-gate (`focusedRunSprintId`) is already satisfied on a
 *     settled Execute view with a pinned sprint. A local handler would toggle it twice per
 *     press. Only the hint is published, gated on the run actually having a sprint to open.
 *
 * Why not `useViewKeys`: that primitive matches on the `input` string and so cannot bind Enter
 * or Esc, which are the settled state's primary keys. The hint array and the handler below sit
 * five lines apart and are reviewed together.
 */

import { useInput } from 'ink';
import type { RouterApi } from '@src/application/ui/tui/runtime/router.tsx';
import { useViewHints } from '@src/application/ui/tui/runtime/use-view-hints.tsx';

interface UseExecuteInputDeps {
  readonly isRunning: boolean;
  readonly cancelScopeOpen: boolean;
  readonly setCancelScopeOpen: (open: boolean) => void;
  readonly modalOpen: boolean;
  readonly router: RouterApi;
  /** Gates the `g progress` hint — with no pinned sprint the global chord is a no-op. */
  readonly hasPinnedSprint: boolean;
  /** Gates the `v evaluation` hint — the chord no-ops until some task has recorded a verdict. */
  readonly hasEvaluation: boolean;
}

export const useExecuteInput = ({
  isRunning,
  cancelScopeOpen,
  setCancelScopeOpen,
  modalOpen,
  router,
  hasPinnedSprint,
  hasEvaluation,
}: UseExecuteInputDeps): void => {
  useViewHints(
    isRunning
      ? cancelScopeOpen
        ? [
            { keys: '1', label: 'cancel attempt' },
            { keys: '2', label: 'cancel whole flow' },
            { keys: 'esc', label: 'back to run' },
          ]
        : [
            { keys: 'c', label: 'cancel' },
            { keys: 'D', label: 'detach' },
            // Advertised WHILE RUNNING too: a failed round mid-run is exactly when an operator
            // wants the critique, and the next generator turn is already consuming it.
            { keys: 'v', label: 'evaluation', enabledWhen: hasEvaluation },
          ]
      : [
          { keys: '↵', label: 'home' },
          { keys: 'r', label: 're-run' },
          { keys: 'g', label: 'progress', enabledWhen: hasPinnedSprint },
          { keys: 'v', label: 'evaluation', enabledWhen: hasEvaluation },
        ]
  );

  useInput((input, key) => {
    if (modalOpen) return;
    if (!isRunning) {
      // Settled run: land on Home, whatever the route stack looks like. The global selection
      // is untouched, so Home renders the user's own project/sprint card.
      if (key.return || key.escape) router.reset({ id: 'home' });
      // Reset (not push) — see the header note: the dead run leaves the stack and Flows
      // re-checks every trigger against the sprint's current status.
      if (input === 'r') router.reset({ id: 'flows' });
      return;
    }
    if (input === 'c' && !cancelScopeOpen) setCancelScopeOpen(true);
    // Detach: drop the run's view and land on Home — the same destination a settled run's
    // Enter/Esc uses. Named explicitly; `reset` never infers a destination (a bare form used to
    // re-mount the process's launch entry, i.e. the first-run wizard on a fresh install).
    if (input === 'D') router.reset({ id: 'home' });
  });
};
