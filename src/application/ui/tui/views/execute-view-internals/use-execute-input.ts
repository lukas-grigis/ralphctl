/**
 * View-hint registration + keyboard handling for the execute view.
 *
 * Hints adapt to three states:
 *   - running + cancel-scope picker open: `1 / 2 / esc` set
 *   - running, picker closed              : `c / D` set
 *   - not running                         : `↵ back`
 *
 * Key handling:
 *   - help / prompt overlays own the keyboard — early-return when active.
 *   - while running: `c` opens the cancel-scope picker (unless already open); `D` detaches
 *     (router.reset, runner continues in background).
 *   - when settled: Enter / Esc resets to Home. ALWAYS Home — never sprint-detail or a
 *     stack pop. A finished flow (refine / plan / implement / …) drops the user back on the
 *     Home card with their own project/sprint selection intact, which is the one place that
 *     summarises "what next". Browsing a run must not decide where the user "is".
 */

import { useInput } from 'ink';
import type { RouterApi } from '@src/application/ui/tui/runtime/router.tsx';
import { useViewHints } from '@src/application/ui/tui/runtime/use-view-hints.tsx';

interface UseExecuteInputDeps {
  readonly isRunning: boolean;
  readonly cancelScopeOpen: boolean;
  readonly setCancelScopeOpen: (open: boolean) => void;
  readonly helpOpen: boolean;
  readonly promptActive: boolean;
  readonly router: RouterApi;
}

export const useExecuteInput = ({
  isRunning,
  cancelScopeOpen,
  setCancelScopeOpen,
  helpOpen,
  promptActive,
  router,
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
          ]
      : [{ keys: '↵', label: 'home' }]
  );

  useInput((input, key) => {
    if (helpOpen || promptActive) return;
    if (!isRunning) {
      // Settled run: land on Home, whatever the route stack looks like. The global selection
      // is untouched, so Home renders the user's own project/sprint card.
      if (key.return || key.escape) router.reset({ id: 'home' });
      return;
    }
    if (input === 'c' && !cancelScopeOpen) setCancelScopeOpen(true);
    if (input === 'D') router.reset();
  });
};
