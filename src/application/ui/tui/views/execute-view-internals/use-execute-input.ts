/**
 * View-hint registration + keyboard handling for the execute view.
 *
 * Bindings (and so hints) adapt to three states:
 *   - running + cancel-scope picker open: `1 / 2 / esc` set
 *   - running, picker closed              : `c / D` set
 *   - not running                         : `↵ home · r re-run · g progress · u unblock`
 *
 * `u` (unblock) is advertised ONLY in the settled set: the Tasks panel's own `u` chord is a
 * no-op while a run is live (`TasksPanelHost` empties `blockedTaskIds` mid-run — see its
 * docstring for the TOCTOU precondition that forces this), so hinting it during a run would
 * advertise a key whose handler rejects every press, which is the exact thing DESIGN-SYSTEM's
 * hint-strip invariant forbids.
 *
 * Key handling:
 *   - help / prompt overlays own the keyboard — the dispatcher mutes itself when active.
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
 * One `useViewKeys` declaration feeds both the hint strip and the dispatcher, so a hint can never
 * advertise a key the handler rejects. `y` (copy the watched task's markdown summary) is
 * Execute-local: it is gated on there being an active task and is inert everywhere else.
 */

import type { RouterApi } from '@src/application/ui/tui/runtime/router.tsx';
import { useViewKeys, type ViewKeyBinding } from '@src/application/ui/tui/runtime/use-view-keys.ts';

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
  /**
   * Gates the settled-only `u unblock` hint — the Tasks panel's `u` chord only fires for a task
   * the polled entities report `status === 'blocked'`. Meaningless while running: the panel
   * forces the chord inert on a live run regardless of this flag, so the hint is never shown then.
   * Defaults to `false` (no hint) so a caller that hasn't wired an entity-blocked signal yet
   * degrades to the pre-existing settled hint set rather than failing to compile.
   */
  readonly hasBlockedTask?: boolean;
  /** `y` handler — copies the active task's summary. Omit (or pair with `canCopyTask: false`) to drop the key. */
  readonly onCopyTask?: () => void;
  /** Gates the `y copy task` hint + handler — `true` only while there is an active task to copy. */
  readonly canCopyTask?: boolean;
}

export const useExecuteInput = ({
  isRunning,
  cancelScopeOpen,
  setCancelScopeOpen,
  modalOpen,
  router,
  hasPinnedSprint,
  hasEvaluation,
  hasBlockedTask = false,
  onCopyTask,
  canCopyTask = false,
}: UseExecuteInputDeps): void => {
  const copyTask: ViewKeyBinding = {
    keys: ['y'],
    hint: 'copy task',
    enabled: canCopyTask && onCopyTask !== undefined,
    run: () => onCopyTask?.(),
  };

  const bindings: readonly ViewKeyBinding[] = isRunning
    ? cancelScopeOpen
      ? [
          // The cancel-scope overlay owns these three (and claims `1` / `2`); listed so the strip teaches them.
          { keys: ['1'], hint: 'cancel attempt' },
          { keys: ['2'], hint: 'cancel whole flow' },
          { keys: ['esc'], hint: 'back to run' },
        ]
      : [
          // Open the picker. Detach drops to Home — named explicitly; `reset` never infers a
          // destination (a bare form used to re-mount the launch entry, i.e. the first-run wizard).
          { keys: ['c'], hint: 'cancel', run: () => setCancelScopeOpen(true) },
          { keys: ['D'], hint: 'detach', run: () => router.reset({ id: 'home' }) },
          // Advertised WHILE RUNNING too: a failed round mid-run is exactly when an operator
          // wants the critique, and the next generator turn is already consuming it.
          { keys: ['v'], hint: 'evaluation', enabled: hasEvaluation },
          copyTask,
        ]
    : [
        // Settled run: land on Home, whatever the route stack looks like. The global selection
        // is untouched, so Home renders the user's own project/sprint card.
        { keys: ['↵'], hint: 'home', run: () => router.reset({ id: 'home' }) },
        { keys: ['esc'], hint: 'home', hidden: true, run: () => router.reset({ id: 'home' }) },
        // Reset (not push) — see the header note: the dead run leaves the stack and Flows
        // re-checks every trigger against the sprint's current status.
        { keys: ['r'], hint: 're-run', run: () => router.reset({ id: 'flows' }) },
        { keys: ['g'], hint: 'progress', enabled: hasPinnedSprint },
        { keys: ['v'], hint: 'evaluation', enabled: hasEvaluation },
        // Settled only — see `hasBlockedTask`'s doc for why running never shows this.
        { keys: ['u'], hint: 'unblock', enabled: hasBlockedTask },
        copyTask,
      ];

  useViewKeys(bindings, { active: !modalOpen });
};
