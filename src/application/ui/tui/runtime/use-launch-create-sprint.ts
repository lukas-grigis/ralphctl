/**
 * `useLaunchCreateSprint` — the create-sprint launch sequence shared by the three views that
 * offer a "create sprint" affordance (home `+` hotkey, pick-sprint synthetic row,
 * sprints `c` chord). Each had a near-verbatim copy of:
 *
 *   load snapshot → createInkInteractivePrompt → launchSprintBoundFlow('create-sprint', …,
 *     { onReseat: selection.setSprint, onSprintResolved: sessions.setPinnedSprint }) →
 *     register + start + push execute
 *
 * The reseat / pinned-sprint wiring is identical across all three; only the feedback channel and
 * the no-project gating wording differ, so both are injected. The register + start + route tail
 * is composed via {@link openFlowSession} (mode defaults to `push`, matching every call site).
 *
 * The returned function is `useCallback`-stable so home-view can list it in a `useMemo`
 * dependency array (the menu builder closes over it) without re-running the memo every render.
 *
 * @public
 */

import { useCallback } from 'react';
import { useDeps } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { useRouter } from '@src/application/ui/tui/runtime/router.tsx';
import { useSelection } from '@src/application/ui/tui/runtime/selection-context.tsx';
import { useSessionManager } from '@src/application/ui/tui/runtime/sessions-context.tsx';
import { useStorage } from '@src/application/ui/tui/runtime/storage-context.tsx';
import { usePromptQueue } from '@src/application/ui/tui/prompts/prompt-context.tsx';
import { createInkInteractivePrompt } from '@src/application/ui/tui/prompts/ink-interactive-prompt.ts';
import { getRunInTerminal } from '@src/application/ui/tui/runtime/run-in-terminal.ts';
import { openFlowSession } from '@src/application/ui/tui/runtime/open-flow-session.ts';
import { launchSprintBoundFlow } from '@src/application/ui/shared/launch/sprint-bound.ts';
import { loadAppStateSnapshot } from '@src/application/ui/shared/state-snapshot.ts';

export interface UseLaunchCreateSprintOpts {
  /**
   * Sink for both gating and launch-failure messages. Each view feeds its own feedback / flash
   * mechanism (home's `flashErr`, the picker / sprints `setFeedback`), so the strings are passed
   * through verbatim — the hook never renders.
   */
  readonly onError: (text: string) => void;
  /**
   * Message shown when there is no current project to create the sprint against. Differs per
   * call site (home / sprints say "pick a project first …"; the picker says "select a project
   * first"), so it is supplied by the caller to keep wording byte-identical.
   */
  readonly noProjectMessage: string;
}

export const useLaunchCreateSprint = (opts: UseLaunchCreateSprintOpts): (() => Promise<void>) => {
  const deps = useDeps();
  const router = useRouter();
  const selection = useSelection();
  const sessions = useSessionManager();
  const storage = useStorage();
  const queue = usePromptQueue();
  const { onError, noProjectMessage } = opts;

  return useCallback(async (): Promise<void> => {
    if (selection.projectId === undefined) {
      onError(noProjectMessage);
      return;
    }
    const snapshot = await loadAppStateSnapshot(deps, { projectId: selection.projectId });
    const interactive = createInkInteractivePrompt(queue);
    const result = await launchSprintBoundFlow(
      { app: deps, interactive, storage, runInTerminal: getRunInTerminal() },
      'create-sprint',
      snapshot,
      {
        onReseat: ({ id, name, status }) => {
          selection.setSprint(id, name, status);
        },
        onSprintResolved: (runnerId, { id, name }) => {
          sessions.setPinnedSprint(runnerId, id, name);
        },
      }
    );
    if (!result.ok) {
      onError(`✗ ${result.reason}`);
      return;
    }
    openFlowSession({ sessions, router }, result, 'create-sprint');
  }, [deps, router, selection, sessions, storage, queue, onError, noProjectMessage]);
};
