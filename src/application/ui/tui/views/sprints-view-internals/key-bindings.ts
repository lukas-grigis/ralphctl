/**
 * The sprint-list key map, extracted from `sprints-view.tsx` so the view stays a wiring surface and
 * the table of "key → what it does → when it is live" reads in one place.
 */

import { glyphs } from '@src/application/ui/tui/theme/tokens.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { ViewKeyBinding } from '@src/application/ui/tui/runtime/use-view-keys.ts';
import type {
  UseSprintRowActionsResult,
  UseStuckSprintTasksResult,
} from '@src/application/ui/tui/views/sprints-view.tsx';
import { createBindings, listMoveBinding } from '@src/application/ui/tui/runtime/keyboard-map.ts';

export interface SprintsKeysInput {
  readonly focusedSprint: Sprint | undefined;
  readonly stuck: UseStuckSprintTasksResult;
  readonly actions: UseSprintRowActionsResult;
  readonly launchCreateSprint: () => Promise<void>;
  readonly reload: () => void;
  /** The current selection's sprint id — `m` is offered only while the focused row differs. */
  readonly currentSprintId: Sprint['id'] | undefined;
  readonly makeCurrent: (sprint: Sprint) => void;
}

/**
 * The sprint-list key map. `e` hides its hint on a done sprint but keeps the handler live —
 * someone who found the key in the `?` overlay still presses it, and a swallowed keystroke reads
 * as a bug, so the handler says why instead. `u` goes the other way: with no stuck tasks there is
 * nothing to explain, so the hint and the handler go dark together. Both read the one gate the
 * body of this function derives, so a hint can never disagree with what the key does.
 */
export const sprintsKeyBindings = ({
  focusedSprint,
  stuck,
  actions,
  launchCreateSprint,
  reload,
  currentSprintId,
  makeCurrent,
}: SprintsKeysInput): readonly ViewKeyBinding[] => {
  const { setFeedback } = actions;
  const focusedDone = focusedSprint?.status === 'done';
  return [
    listMoveBinding,
    { keys: ['↵'], hint: 'open' },
    // Explicit make-current — opening a sprint is a browse and never switches the selection.
    {
      keys: ['m'],
      hint: 'current',
      enabled: focusedSprint !== undefined && focusedSprint.id !== currentSprintId,
      run: () => {
        if (focusedSprint !== undefined) makeCurrent(focusedSprint);
      },
    },
    ...createBindings(() => {
      void launchCreateSprint();
    }),
    {
      keys: ['e'],
      hint: 'rename',
      hidden: focusedDone,
      run: () => {
        if (focusedSprint === undefined) return;
        if (focusedDone) {
          setFeedback(`${glyphs.cross} done sprints can't be renamed`);
          return;
        }
        actions.handleRename(focusedSprint);
      },
    },
    {
      keys: ['d'],
      hint: 'delete',
      run: () => {
        if (focusedSprint !== undefined) actions.setConfirmDelete(focusedSprint);
      },
    },
    {
      keys: ['u'],
      hint: `unblock (${String(stuck.stuckCount)})`,
      enabled: stuck.stuckCount > 0,
      run: () => {
        void stuck.unblockAll(focusedSprint, setFeedback, reload);
      },
    },
    {
      keys: ['r'],
      hint: 'reload',
      run: () => {
        setFeedback(`${glyphs.refresh} reloading…`);
        reload();
      },
    },
  ];
};
