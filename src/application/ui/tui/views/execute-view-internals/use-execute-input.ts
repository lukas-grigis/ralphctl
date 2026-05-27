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
 *   - when settled: Enter / Esc returns to sprint-detail (when a sprint is selected) or
 *     pops the route stack.
 */

import { useInput } from 'ink';
import type { RouterApi } from '@src/application/ui/tui/runtime/router.tsx';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { useViewHints } from '@src/application/ui/tui/runtime/use-view-hints.tsx';

interface UseExecuteInputDeps {
  readonly isRunning: boolean;
  readonly cancelScopeOpen: boolean;
  readonly setCancelScopeOpen: (open: boolean) => void;
  readonly helpOpen: boolean;
  readonly promptActive: boolean;
  readonly router: RouterApi;
  readonly sprintId: SprintId | undefined;
}

export const useExecuteInput = ({
  isRunning,
  cancelScopeOpen,
  setCancelScopeOpen,
  helpOpen,
  promptActive,
  router,
  sprintId,
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
      : [{ keys: '↵', label: 'back' }]
  );

  useInput((input, key) => {
    if (helpOpen || promptActive) return;
    if (!isRunning) {
      if (key.return || key.escape) {
        if (sprintId !== undefined) {
          router.reset({ id: 'sprint-detail', props: { sprintId } });
        } else {
          router.pop();
        }
      }
      return;
    }
    if (input === 'c' && !cancelScopeOpen) setCancelScopeOpen(true);
    if (input === 'D') router.reset();
  });
};
