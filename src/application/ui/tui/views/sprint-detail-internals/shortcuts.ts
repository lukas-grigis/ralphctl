/**
 * Keymap hook for the sprint-detail view. Encapsulates every `useInput` chord — focus
 * navigation, expand/collapse, ticket add/remove, edit field, mark-current, unblock — into one
 * place so the orchestrator only has to wire state and handler callbacks.
 *
 * Mute conditions (help overlay open, a queued prompt is active, the remove-confirm sub-view is
 * mounted, the sprint hasn't loaded yet) are checked once at the top and short-circuit every
 * key, mirroring the original inline handler.
 */

import { useInput, type Key } from 'ink';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { Ticket } from '@src/domain/entity/ticket.ts';
import type { FocusItem } from '@src/application/ui/tui/views/sprint-detail-internals/focus-list.ts';

interface SprintDetailShortcutArgs {
  readonly modalOpen: boolean;
  readonly confirmRemoveActive: boolean;
  readonly sprint: Sprint | undefined;
  readonly inDetail: boolean;
  readonly ticketsEditable: boolean;
  readonly canEdit: boolean;
  readonly isCurrent: boolean;
  readonly focusList: readonly FocusItem[];
  readonly cursorIdx: number;
  readonly focusedStuckTask: Task | undefined;
  // Actions ------------------------------------------------------------------
  readonly closeAllExpanded: () => void;
  readonly openAddTicket: (sprintId: Sprint['id']) => void;
  readonly toggleExpand: (id: string) => void;
  // Note: moveCursor removed — cursor navigation (↑/↓ / j/k / PgUp/PgDn / Home/End) is now
  // owned by `useListWindow` in the orchestrator. This hook handles only view-local keys.
  readonly beginRemove: (ticket: Ticket) => void;
  readonly markCurrent: (sprint: Sprint) => void;
  readonly handleEdit: () => void;
  readonly handleUnblock: (task: Task) => void;
}

/** One keymap row — `guard` gates whether `key` fires in the current state; `action` runs on a match. */
interface ShortcutRow {
  readonly key: (input: string, keyEvent: Key) => boolean;
  readonly guard: (args: SprintDetailShortcutArgs, sprint: Sprint) => boolean;
  readonly action: (args: SprintDetailShortcutArgs, sprint: Sprint) => void;
}

/** Item under the cursor in the flat focus list, clamped to the last entry when the cursor has
 * drifted past the end (e.g. the list just shrank). `undefined` for an empty list. */
const focusedItem = (args: SprintDetailShortcutArgs): FocusItem | undefined =>
  args.focusList[Math.min(args.cursorIdx, args.focusList.length - 1)];

/**
 * The sprint-detail keymap, in declaration order — first row whose `key` AND `guard` both match
 * wins. Mirrors the original inline `if (input === X && <guard>)` chain exactly; every row here
 * is that same shape, just data instead of code.
 */
const SHORTCUT_ROWS: readonly ShortcutRow[] = [
  {
    // Esc/q collapses every expanded card in one action; falls through to global pop otherwise.
    key: (input, keyEvent) => keyEvent.escape || input === 'q',
    guard: (args) => args.inDetail,
    action: (args) => args.closeAllExpanded(),
  },
  {
    key: (input) => input === 'a',
    guard: (args) => args.ticketsEditable,
    action: (args, sprint) => args.openAddTicket(sprint.id),
  },
  {
    key: (input) => input === 'e',
    guard: (args) => args.canEdit,
    action: (args) => args.handleEdit(),
  },
  {
    // Explicit "make this sprint current". Replaces the prior silent auto-sync on mount — the
    // user now opts in. No-op if already current so re-pressing doesn't churn feedback.
    key: (input) => input === 'm',
    guard: (args) => !args.isCurrent,
    action: (args, sprint) => args.markCurrent(sprint),
  },
  {
    // The view advertises `n — flows` as "scoped to this sprint", so honour it: reseat the
    // selection onto the viewed sprint before the navigation lands. The actual route push is
    // owned by the GLOBAL `n` handler (use-global-keys), which processes the same keystroke —
    // this hook only fixes up the selection, so the two handlers compose instead of
    // double-pushing the Flows view.
    key: (input) => input === 'n',
    guard: (args) => !args.isCurrent,
    action: (args, sprint) => args.markCurrent(sprint),
  },
  {
    // ↑/↓/j/k/PgUp/PgDn/Home/End are handled by `useListWindow` in the orchestrator — no
    // moveCursor calls here. We only handle view-local keys in this table.
    key: (input, keyEvent) => keyEvent.return || input === 'o',
    guard: (args) => args.focusList.length > 0,
    action: (args) => {
      const target = focusedItem(args);
      if (target === undefined) return;
      const targetId = target.kind === 'ticket' ? String(target.ticket.id) : String(target.task.id);
      args.toggleExpand(targetId);
    },
  },
  {
    key: (input) => input === 'd',
    guard: (args) => args.ticketsEditable,
    action: (args) => {
      const focused = focusedItem(args);
      if (focused?.kind === 'ticket') args.beginRemove(focused.ticket);
    },
  },
  {
    key: (input) => input === 'u',
    guard: (args) => args.focusedStuckTask !== undefined,
    action: (args) => args.handleUnblock(args.focusedStuckTask!),
  },
];

export const useSprintDetailShortcuts = (args: SprintDetailShortcutArgs): void => {
  useInput((input, key) => {
    if (args.modalOpen || args.confirmRemoveActive || args.sprint === undefined) return;
    const sprint = args.sprint;
    const row = SHORTCUT_ROWS.find((r) => r.key(input, key) && r.guard(args, sprint));
    row?.action(args, sprint);
  });
};
