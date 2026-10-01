/**
 * `useLaunchCreateSprint` — the create-sprint launch sequence shared by the three views that offer a "create sprint"
 * affordance (home `+` hotkey, context-switcher `+ New sprint` row, sprints `c` chord).
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
import { glyphs } from '@src/application/ui/tui/theme/tokens.ts';

export interface UseLaunchCreateSprintOpts {
  /** Sink for both gating and launch-failure messages. */
  readonly onError: (text: string) => void;
  /** Message shown when there is no current project to create the sprint against. */
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
    const interactive = createInkInteractivePrompt(queue, deps.eventBus);
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
      onError(`${glyphs.cross} ${result.reason}`);
      return;
    }
    openFlowSession({ sessions, router }, result, 'create-sprint');
  }, [deps, router, selection, sessions, storage, queue, onError, noProjectMessage]);
};
