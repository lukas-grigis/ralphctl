/** Work's behaviour: what ↵ does per agenda row, and the local keys (declared once, hint = handler). */

import { useCallback } from 'react';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { useRouter } from '@src/application/ui/tui/runtime/router.tsx';
import { useViewKeys } from '@src/application/ui/tui/runtime/use-view-keys.ts';
import { listMoveBinding } from '@src/application/ui/tui/runtime/keyboard-map.ts';
import { useLaunchCreateSprint } from '@src/application/ui/tui/runtime/use-launch-create-sprint.ts';
import { useUnblockTask } from '@src/application/ui/tui/runtime/use-unblock-task.ts';
import type { StructuredFeedback } from '@src/application/ui/tui/components/feedback-line.tsx';
import type { AgendaRow } from '@src/application/ui/tui/views/home-internals/agenda.ts';
import { glyphs } from '@src/application/ui/tui/theme/tokens.ts';
import type { AppStateSnapshot } from '@src/application/ui/shared/state-snapshot.ts';

export interface UseWorkActionsArgs {
  readonly snapshot: AppStateSnapshot | undefined;
  readonly agenda: readonly AgendaRow[];
  readonly focusedId: string | undefined;
  readonly showAll: boolean;
  readonly toggleShowAll: () => void;
  readonly launch: (flowId: string) => Promise<void>;
  readonly reload: () => void;
  readonly show: (f: StructuredFeedback) => void;
}

const NO_PROJECT = `pick a project first (S switch, or Projects ${glyphs.arrowRight} open one)`;

/**
 * Stale run records are superseded only once the resume actually started — a cancelled or refused launch keeps them.
 * Stable across renders while its inputs are, so the actions' `run` / items don't rebuild every frame.
 */
export const useResumeAwareLaunch = (
  launch: (flowId: string) => Promise<boolean>,
  dismissStale: () => Promise<void>
): ((flowId: string) => Promise<void>) =>
  useCallback(
    async (flowId: string): Promise<void> => {
      const started = await launch(flowId);
      if (started && flowId === 'implement') await dismissStale();
    },
    [launch, dismissStale]
  );

/** Returns `run`, the ↵ handler for a row. */
export const useWorkActions = (args: UseWorkActionsArgs): ((row: AgendaRow) => void) => {
  const { snapshot, agenda, focusedId, showAll, toggleShowAll, launch, reload, show } = args;
  const router = useRouter();
  const ui = useUiState();
  const unblockTask = useUnblockTask();
  const launchCreateSprint = useLaunchCreateSprint({
    onError: (text) => show({ tone: 'error', text: text.replace(`${glyphs.cross} `, '') }),
    noProjectMessage: NO_PROJECT,
  });
  const sprint = snapshot?.sprint;

  const openSprint = useCallback(
    (focusTaskId?: string): void => {
      if (sprint === undefined) return;
      router.push({
        id: 'sprint-detail',
        props: { sprintId: sprint.id, sprintName: sprint.name, ...(focusTaskId !== undefined ? { focusTaskId } : {}) },
      });
    },
    [router, sprint]
  );

  const run = useCallback(
    (row: AgendaRow): void => {
      const { action } = row;
      if (action.kind === 'open-task') openSprint(action.taskId);
      else if (action.kind === 'open-sprint') openSprint();
      else if (action.kind === 'open-session') router.push({ id: 'execute', props: { sessionId: action.sessionId } });
      else void launch(action.flowId);
    },
    [openSprint, router, launch]
  );

  const focusedRow = agenda.find((r) => r.id === focusedId);
  const focusedTaskId = focusedRow?.action.kind === 'open-task' ? focusedRow.action.taskId : undefined;
  const focusedTask = snapshot?.tasks.find((t) => t.id === focusedTaskId);

  const unblock = (): void => {
    if (focusedTask === undefined || sprint === undefined) return;
    void unblockTask(focusedTask, sprint.id).then((result) => {
      show(
        result.ok
          ? { tone: 'success', text: `unblocked "${focusedTask.name}"` }
          : { tone: 'error', text: `could not unblock "${focusedTask.name}" — ${result.error.message}` }
      );
      reload();
    });
  };
  const createNew = (): void => {
    if (snapshot?.projectCount === 0) router.push({ id: 'create-project' });
    else void launchCreateSprint();
  };

  const newHint = snapshot?.projectCount === 0 ? 'new project' : 'new sprint';
  const loaded = snapshot !== undefined;
  useViewKeys(
    [
      { keys: ['↵'], hint: focusedRow?.verb ?? 'open', enabled: focusedRow !== undefined },
      { keys: ['u'], hint: 'unblock', enabled: focusedTask !== undefined, run: unblock },
      { keys: ['o'], hint: 'sprint', enabled: sprint !== undefined, run: () => openSprint() },
      { keys: ['c'], hint: newHint, enabled: loaded, run: createNew },
      { keys: ['+'], hint: newHint, hidden: true, enabled: loaded, run: createNew }, // silent alias of `c`
      listMoveBinding,
      {
        keys: ['a'],
        hint: 'add ticket',
        enabled: sprint?.status === 'draft',
        run: () => router.push({ id: 'add-ticket', props: { sprintId: sprint?.id } }),
      },
      {
        keys: ['v'],
        hint: showAll ? 'fewer flows' : 'all flows',
        enabled: agenda.length > 0 || showAll,
        run: toggleShowAll,
      },
      { keys: ['b'], hint: 'banner', run: ui.toggleBanner },
      { keys: ['r'], hint: 'reload', run: reload },
    ],
    { active: !ui.modalOpen }
  );

  return run;
};
