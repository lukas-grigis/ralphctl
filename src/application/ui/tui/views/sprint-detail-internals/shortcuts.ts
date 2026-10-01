/**
 * Keymap hook for the sprint-detail view. One `useViewKeys` declaration covers every chord —
 * focus navigation, expand/collapse, ticket add/remove/publish, edit field, mark-current,
 * unblock, jump-to-next-blocked — so the footer hints and the handlers share one gate each.
 *
 * Mute conditions (an app overlay, a queued prompt, the remove-confirm sub-view) mute the whole
 * dispatcher; an unloaded sprint simply leaves every sprint-bound binding disabled.
 */

import { useViewKeys, type ViewKeyBinding } from '@src/application/ui/tui/runtime/use-view-keys.ts';
import { listMoveBinding } from '@src/application/ui/tui/runtime/keyboard-map.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { Ticket } from '@src/domain/entity/ticket.ts';
import type { FocusItem, JumpControls } from '@src/application/ui/tui/views/sprint-detail-internals/focus-list.ts';

interface SprintDetailShortcutArgs {
  readonly modalOpen: boolean;
  readonly confirmRemoveActive: boolean;
  readonly sprint: Sprint | undefined;
  readonly inDetail: boolean;
  readonly ticketsEditable: boolean;
  readonly canEdit: boolean;
  readonly isCurrent: boolean;
  /** Blocked tasks in the sprint — gates the `B` hint (the chord itself gates on `jump.available`). */
  readonly blockedCount: number;
  readonly focusList: readonly FocusItem[];
  readonly cursorIdx: number;
  readonly focusedStuckTask: Task | undefined;
  /** Focused task that recorded an evaluation verdict — the gate for `v`. */
  readonly focusedEvaluatedTask: Task | undefined;
  /** Jump-to-next-blocked (`B`) controls — see `focus-list.ts`'s `JumpControls` doc comment. */
  readonly jump: JumpControls;
  // Actions ------------------------------------------------------------------
  readonly closeAllExpanded: () => void;
  readonly openAddTicket: (sprintId: Sprint['id']) => void;
  readonly toggleExpand: (id: string) => void;
  // Note: moveCursor removed — cursor navigation (↑/↓ / j/k / PgUp/PgDn / Home/End) is normally
  // owned by `useListWindow` in the orchestrator; this hook's own movement rows (bottom of
  // `SHORTCUT_ROWS`) only take over once a `B` jump has engaged `jump.active`. Otherwise this
  // hook handles only view-local keys.
  readonly beginRemove: (ticket: Ticket) => void;
  readonly markCurrent: (sprint: Sprint) => void;
  /** Push the Flows view. The view owns `n` (see the binding below), so it navigates itself. */
  readonly openFlows: () => void;
  readonly handleEdit: () => void;
  readonly handlePublish: (ticket: Ticket) => void;
  readonly handleUnblock: (task: Task) => void;
  readonly openEvaluation: (task: Task) => void;
  /**
   * Re-read the sprint bundle from disk. Mirrors `sprints-view.tsx`'s `r` — the fix for the
   * conflict toast's "then u again here" instruction: this view never polls, so an out-of-process
   * `ralphctl sprint reopen` (or any other external mutation) is invisible here until something
   * re-triggers `useSprintBundle`'s loader. `r` is that trigger.
   */
  readonly reloadSprint: () => void;
}

/** Item under the cursor in the flat focus list, clamped to the last entry when the cursor has
 * drifted past the end (e.g. the list just shrank). `undefined` for an empty list. */
const focusedItem = (args: SprintDetailShortcutArgs): FocusItem | undefined =>
  args.focusList[Math.min(args.cursorIdx, args.focusList.length - 1)];

/**
 * The rows below only ever fire once a `B` jump has engaged `jump.active` — until then
 * ↑/↓/j/k/PgUp/PgDn/Home/End stay owned entirely by `useListWindow` in the orchestrator.
 * `useListWindow`'s cursor is paused the moment a jump engages (see `detail-body.tsx`'s
 * `useFocusModel`), so these never double-handle a keypress against it.
 */
const buildJumpMovementBindings = (jump: JumpControls): readonly ViewKeyBinding[] => [
  { keys: ['↑', 'k'], hint: 'move', hidden: true, enabled: jump.active, run: () => jump.moveBy(-1) },
  { keys: ['↓', 'j'], hint: 'move', hidden: true, enabled: jump.active, run: () => jump.moveBy(1) },
  { keys: ['PgUp'], hint: 'page up', hidden: true, enabled: jump.active, run: () => jump.moveBy(-jump.pageSize) },
  { keys: ['PgDn'], hint: 'page down', hidden: true, enabled: jump.active, run: () => jump.moveBy(jump.pageSize) },
  { keys: ['Home'], hint: 'first', hidden: true, enabled: jump.active, run: () => jump.moveToEdge('start') },
  { keys: ['End'], hint: 'last', hidden: true, enabled: jump.active, run: () => jump.moveToEdge('end') },
];

/**
 * The bindings that act on the sprint / focused task's STATE (make current, unblock, reload, jump
 * to blocked, open the evaluation). `canPublish` only decides whether `m` hides its hint.
 */
const buildStateBindings = (args: SprintDetailShortcutArgs, canPublish: boolean): readonly ViewKeyBinding[] => {
  const { sprint, jump } = args;
  const loaded = sprint !== undefined;
  return [
    {
      // Explicit "make this sprint current" — the user opts in. No-op if already current so
      // re-pressing doesn't churn feedback.
      keys: ['m'],
      hint: 'current',
      enabled: loaded && !args.isCurrent,
      hidden: args.focusedStuckTask !== undefined || canPublish,
      run: () => {
        if (sprint !== undefined) args.markCurrent(sprint);
      },
    },
    {
      keys: ['u'],
      hint: 'unblock',
      enabled: args.focusedStuckTask !== undefined,
      run: () => {
        if (args.focusedStuckTask !== undefined) args.handleUnblock(args.focusedStuckTask);
      },
    },
    {
      // Always available, like `sprints-view.tsx`'s `r` — re-fetches the sprint bundle so an
      // out-of-process mutation (e.g. `ralphctl sprint reopen`) becomes visible here without
      // leaving and re-entering the view.
      keys: ['r'],
      hint: 'reload',
      hidden: true,
      run: args.reloadSprint,
    },
    {
      // Uppercase `B` — lowercase `b` is the GLOBAL banner toggle, so the shifted variant is
      // deliberate. Jumps the flat cursor straight to the next blocked task (wrapping).
      keys: ['B'],
      hint: 'next blocked',
      enabled: jump.available,
      hidden: args.blockedCount === 0,
      run: jump.jumpToNextBlocked,
    },
    {
      // `v` opens the focused task's evaluation verdict. Ticket rows and tasks that never reached
      // the evaluator stay inert. CLOSING is global — the dispatcher mutes itself the moment the
      // overlay opens, which keeps the two halves from fighting.
      keys: ['v'],
      hint: 'evaluation',
      enabled: args.focusedEvaluatedTask !== undefined,
      run: () => {
        if (args.focusedEvaluatedTask !== undefined) args.openEvaluation(args.focusedEvaluatedTask);
      },
    },
  ];
};

/**
 * The sprint-detail keymap, in declaration order — the first enabled binding whose key matches
 * wins. Labels stay terse: the rendered strip must fit a 100-column terminal on ONE line, which
 * is also why `m` hides its hint (handler stays live) while a stuck task or ticket is focused,
 * and why there is no `r reload` hint although the chord is always live — the help overlay lists
 * `r`, and the reopen-conflict toast (the one moment it matters) names it.
 */
const buildBindings = (args: SprintDetailShortcutArgs): readonly ViewKeyBinding[] => {
  const sprint = args.sprint;
  const loaded = sprint !== undefined;
  const focused = focusedItem(args);
  const focusedTicket = focused?.kind === 'ticket' ? focused.ticket : undefined;
  // Done sprints are immutable, so publishing is inert there.
  const canPublish = loaded && sprint.status !== 'done' && focusedTicket !== undefined;
  const { jump } = args;
  return [
    listMoveBinding,
    {
      // The view advertises `n — flows` as "scoped to this sprint", so honour it: reseat the
      // selection onto the viewed sprint, then navigate. The view owns `n` (it claims it), so the
      // global handler stands down and this binding does the push itself — exactly once.
      keys: ['n'],
      hint: 'work',
      run: () => {
        if (sprint !== undefined && !args.isCurrent) args.markCurrent(sprint);
        args.openFlows();
      },
    },
    {
      keys: ['↵', 'o'],
      hint: args.inDetail ? 'toggle' : 'expand',
      enabled: args.focusList.length > 0,
      run: () => {
        if (focused === undefined) return;
        args.toggleExpand(focused.kind === 'ticket' ? String(focused.ticket.id) : String(focused.task.id));
      },
    },
    // Esc/q collapses every expanded card in one action; falls through to global pop otherwise.
    { keys: ['esc', 'q'], hint: 'collapse', enabled: args.inDetail, run: args.closeAllExpanded },
    {
      keys: ['a'],
      hint: 'add',
      enabled: loaded && args.ticketsEditable,
      run: () => {
        if (sprint !== undefined) args.openAddTicket(sprint.id);
      },
    },
    { keys: ['e'], hint: 'edit', enabled: loaded && args.canEdit, run: args.handleEdit },
    {
      keys: ['d'],
      hint: 'remove',
      enabled: loaded && args.ticketsEditable,
      run: () => {
        if (focusedTicket !== undefined) args.beginRemove(focusedTicket);
      },
    },
    {
      // `p` is unused globally (`P` is pick-project) and unused elsewhere in this view. Fires on
      // any focused ticket row of an open sprint — draft or not — so the comment path is
      // reachable after the sprint leaves draft. No prompt; the flow writes or surfaces the
      // tracker error.
      keys: ['p'],
      hint: 'publish',
      enabled: canPublish,
      run: () => {
        if (focusedTicket !== undefined) args.handlePublish(focusedTicket);
      },
    },
    ...buildStateBindings(args, canPublish),
    ...buildJumpMovementBindings(jump),
  ];
};

export const useSprintDetailShortcuts = (args: SprintDetailShortcutArgs): void => {
  useViewKeys(buildBindings(args), { active: !args.modalOpen && !args.confirmRemoveActive });
};
