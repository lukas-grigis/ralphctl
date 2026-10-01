/** View-hint registration + keyboard handling for the execute view. */

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
   * Gates the settled-only `u unblock` hint — the Tasks panel's `u` chord only fires for a task the polled entities
   * report `status === 'blocked'`.
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
          // Open the picker.
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
        { keys: ['↵'], hint: 'work', run: () => router.reset({ id: 'home' }) },
        // `esc` back out of a run opened from Runs / Flows is the global pop (what the footer's `esc <parent>` names);
        // only a run at the stack root has nowhere to pop to and lands on Work.
        {
          keys: ['esc'],
          hint: 'work',
          hidden: true,
          run: () => {
            if (router.stack.length <= 1) router.reset({ id: 'home' });
          },
        },
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
