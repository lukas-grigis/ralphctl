/**
 * Sprint detail — shortcut action closures.
 *
 * `buildShortcutsActions` assembles the `a`/`m`/↵/`d`/`p`/`u`/`r` closures `useSprintDetailShortcuts`
 * needs, spread into its config alongside the plain gate fields `detail-body.tsx` computes
 * directly. Split out purely to keep `detail-body.tsx` under the file line budget — same
 * behaviour, just relocated.
 */

import type { Dispatch, SetStateAction } from 'react';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { Ticket } from '@src/domain/entity/ticket.ts';
import { glyphs } from '@src/application/ui/tui/theme/tokens.ts';
import { latestRecordedEvaluation } from '@src/business/task/evaluation-artifact.ts';
import type { EvaluationTarget } from '@src/application/ui/tui/runtime/evaluation-target.ts';
import type { useRouter } from '@src/application/ui/tui/runtime/router.tsx';
import type { useSelection } from '@src/application/ui/tui/runtime/selection-context.tsx';

export interface BuildShortcutsActionsArgs {
  readonly selection: ReturnType<typeof useSelection>;
  readonly router: ReturnType<typeof useRouter>;
  readonly setOpenIds: Dispatch<SetStateAction<ReadonlySet<string>>>;
  readonly setConfirmRemove: (ticket: Ticket | undefined) => void;
  readonly setFeedback: (message: string) => void;
  readonly onUnblock: (task: Task) => Promise<void>;
  readonly onPublish: (ticket: Ticket) => Promise<void>;
  readonly sprintId: SprintId | undefined;
  readonly openEvaluationOverlay: (target: EvaluationTarget) => void;
  /** Re-reads the sprint bundle — threaded through to the `r` chord's `reloadSprint` action. */
  readonly reload: () => void;
}

/**
 * Build the `useSprintDetailShortcuts` action closures (`a`/`m`/↵/`d`/`p`/`u`/`r`) — spread into the
 * hook's config alongside the plain gate fields so the call site stays a flat list.
 */
export const buildShortcutsActions = (args: BuildShortcutsActionsArgs) => {
  const {
    selection,
    router,
    setOpenIds,
    setConfirmRemove,
    setFeedback,
    onUnblock,
    onPublish,
    sprintId,
    openEvaluationOverlay,
    reload,
  } = args;
  return {
    closeAllExpanded: () => setOpenIds(new Set()),
    openAddTicket: (id: SprintId) => router.push({ id: 'add-ticket', props: { sprintId: id } }),
    toggleExpand: (id: string) =>
      setOpenIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    beginRemove: (ticket: Ticket) => setConfirmRemove(ticket),
    markCurrent: (s: Sprint) => {
      selection.setSprint(s.id, s.name, s.status);
      setFeedback(`${glyphs.check} now on ${s.name}`);
    },
    handleUnblock: (task: Task) => {
      void onUnblock(task);
    },
    handlePublish: (ticket: Ticket) => {
      void onPublish(ticket);
    },
    // The full target is assembled here (not inside the overlay) so its degrade arms never need a
    // second repository read — see `runtime/evaluation-target.ts`.
    openEvaluation: (task: Task) => {
      const latest = latestRecordedEvaluation(task);
      if (sprintId === undefined || latest === undefined) return;
      openEvaluationOverlay({
        sprintId,
        taskId: String(task.id),
        taskLabel: task.name,
        attemptN: latest.attemptN,
        status: latest.status,
        ...(latest.file.length > 0 ? { file: latest.file } : {}),
        ...(latest.finishedAt !== undefined ? { finishedAt: latest.finishedAt } : {}),
      });
    },
    // See `shortcuts.ts`'s `reloadSprint` doc comment — this is the operator's only way to see an
    // out-of-process sprint mutation without leaving and re-entering the view.
    reloadSprint: () => {
      setFeedback(`${glyphs.refresh} reloading…`);
      reload();
    },
  };
};
