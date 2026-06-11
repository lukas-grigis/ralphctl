/**
 * Keymap hook for the sprint-detail view. Encapsulates every `useInput` chord — focus
 * navigation, expand/collapse, ticket add/remove, edit field, mark-current, unblock — into one
 * place so the orchestrator only has to wire state and handler callbacks.
 *
 * Mute conditions (help overlay open, a queued prompt is active, the remove-confirm sub-view is
 * mounted, the sprint hasn't loaded yet) are checked once at the top and short-circuit every
 * key, mirroring the original inline handler.
 */

import { useInput } from 'ink';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { Ticket } from '@src/domain/entity/ticket.ts';
import type { FocusItem } from '@src/application/ui/tui/views/sprint-detail-internals/focus-list.ts';

interface SprintDetailShortcutArgs {
  readonly helpOpen: boolean;
  readonly promptActive: boolean;
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
  readonly moveCursor: (delta: 1 | -1) => void;
  readonly beginRemove: (ticket: Ticket) => void;
  readonly markCurrent: (sprint: Sprint) => void;
  readonly handleEdit: () => void;
  readonly handleUnblock: (task: Task) => void;
}

export const useSprintDetailShortcuts = (args: SprintDetailShortcutArgs): void => {
  useInput((input, key) => {
    if (args.helpOpen || args.promptActive || args.confirmRemoveActive || args.sprint === undefined) return;
    const sprint = args.sprint;
    // Esc/q collapses every expanded card in one action; falls through to global pop otherwise.
    if ((key.escape || input === 'q') && args.inDetail) {
      args.closeAllExpanded();
      return;
    }
    if (input === 'a' && args.ticketsEditable) {
      args.openAddTicket(sprint.id);
      return;
    }
    if (input === 'e' && args.canEdit) {
      args.handleEdit();
      return;
    }
    if (input === 'm') {
      // Explicit "make this sprint current". Replaces the prior silent auto-sync on mount —
      // the user now opts in. No-op if already current so re-pressing doesn't churn feedback.
      if (!args.isCurrent) {
        args.markCurrent(sprint);
      }
      return;
    }
    if (input === 'n') {
      // The view advertises `n — flows` as "scoped to this sprint", so honour it: reseat the
      // selection onto the viewed sprint before the navigation lands. The actual route push is
      // owned by the GLOBAL `n` handler (use-global-keys), which processes the same keystroke
      // — this hook only fixes up the selection, so the two handlers compose instead of
      // double-pushing the Flows view.
      if (!args.isCurrent) {
        args.markCurrent(sprint);
      }
      return;
    }
    if ((key.downArrow || input === 'j') && args.focusList.length > 0) {
      args.moveCursor(1);
      return;
    }
    if ((key.upArrow || input === 'k') && args.focusList.length > 0) {
      args.moveCursor(-1);
      return;
    }
    if ((key.return || input === 'o') && args.focusList.length > 0) {
      const target = args.focusList[Math.min(args.cursorIdx, args.focusList.length - 1)];
      if (target === undefined) return;
      const targetId = target.kind === 'ticket' ? String(target.ticket.id) : String(target.task.id);
      args.toggleExpand(targetId);
      return;
    }
    if (input === 'd' && args.ticketsEditable) {
      const focused = args.focusList[Math.min(args.cursorIdx, args.focusList.length - 1)];
      if (focused?.kind === 'ticket') args.beginRemove(focused.ticket);
      return;
    }
    if (input === 'u' && args.focusedStuckTask !== undefined) {
      args.handleUnblock(args.focusedStuckTask);
    }
  });
};
