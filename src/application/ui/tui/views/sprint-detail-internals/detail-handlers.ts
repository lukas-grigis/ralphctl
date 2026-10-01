/** Sprint detail — async action handlers. */

import type { RefObject } from 'react';
import type { useEditField } from '@src/application/ui/tui/runtime/use-edit-field.ts';
import type { usePromptQueue } from '@src/application/ui/tui/prompts/prompt-context.tsx';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { Ticket } from '@src/domain/entity/ticket.ts';
import { glyphs } from '@src/application/ui/tui/theme/tokens.ts';
import { createTicketPublishFlow } from '@src/application/flows/publish-ticket/flow.ts';
import type { TicketPublishDeps } from '@src/application/flows/publish-ticket/deps.ts';
import { createTicketRemoveFlow } from '@src/application/flows/remove-ticket/flow.ts';
import type { TicketRemoveDeps } from '@src/application/flows/remove-ticket/deps.ts';
import type { UnblockTask } from '@src/application/ui/tui/runtime/use-unblock-task.ts';
import type { UnblockTaskOutput } from '@src/business/task/unblock-task.ts';
import { runEdit } from '@src/application/ui/tui/views/sprint-detail-internals/field-editors.ts';
import type { FocusModel } from '@src/application/ui/tui/views/sprint-detail-internals/detail-body.tsx';

interface RunUnblockArgs {
  readonly target: Task;
  readonly sprintId: SprintId;
  readonly unblockTask: UnblockTask;
  readonly mountedRef: RefObject<boolean>;
  readonly setFeedback: (message: string) => void;
  readonly reload: () => void;
}

/** The `u` toast for one unblocked task. */
const unblockedToast = (name: string, sprintId: SprintId, out: UnblockTaskOutput): string => {
  const head = `unblocked "${name}"`;
  const conflict = out.sprintReopenConflict;
  // The task IS revived, but its sprint stayed closed — so this is not a plain success.
  if (conflict !== undefined) {
    const hintClause = conflict.hint !== undefined ? ` ${glyphs.emDash} ${conflict.hint}` : '';
    const retry = `then 'ralphctl sprint reopen ${String(sprintId)}', then r to reload, then u again`;
    return `${glyphs.warningGlyph} ${head} ${glyphs.emDash} ${conflict.message}${hintClause} ${glyphs.emDash} ${retry}`;
  }
  const reopened = out.sprintReopened;
  if (reopened === undefined) return `${glyphs.check} ${head}`;
  // `from === sprint.status` means the retried hop failed AGAIN (see `SprintReopened`'s doc comment in
  // `business/task/unblock-task.ts`) — nothing actually moved.
  const hop =
    reopened.from === reopened.sprint.status
      ? `sprint still ${reopened.sprint.status}`
      : `sprint reopened ${reopened.from} ${glyphs.arrowRight} ${reopened.sprint.status}`;
  // Stopped short of `active` (the second hop failed to persist), implement still can't run it.
  return reopened.sprint.status === 'active'
    ? `${glyphs.check} ${head} ${glyphs.emDash} ${hop}`
    : `${glyphs.warningGlyph} ${head} ${glyphs.emDash} ${hop}, not active`;
};

/**
 * Run the unblock use case (via the shared `useUnblockTask` hook) for one stuck task (the `u` chord) and thread the
 * result to feedback + reload.
 */
const runUnblock = async (args: RunUnblockArgs): Promise<void> => {
  const { target, sprintId, unblockTask, mountedRef, setFeedback, reload } = args;
  const r = await unblockTask(target, sprintId);
  if (!r.ok) {
    if (mountedRef.current) setFeedback(`${glyphs.cross} ${r.error.message}`);
    return;
  }
  if (!mountedRef.current) return;
  setFeedback(unblockedToast(target.name, sprintId, r.value));
  reload();
};

interface RunRemoveTicketArgs {
  readonly target: Ticket;
  readonly sprintId: SprintId;
  readonly sprintRepo: TicketRemoveDeps['sprintRepo'];
  readonly mountedRef: RefObject<boolean>;
  readonly setFeedback: (message: string) => void;
  readonly reload: () => void;
}

/** Run the ticket-remove flow for one confirmed removal and thread the result to feedback + reload. */
const runRemoveTicket = async (args: RunRemoveTicketArgs): Promise<void> => {
  const { target, sprintId, sprintRepo, mountedRef, setFeedback, reload } = args;
  const flow = createTicketRemoveFlow({ sprintRepo });
  const r = await flow.execute({ input: { sprintId, ticketId: target.id } });
  if (!r.ok) {
    if (mountedRef.current) setFeedback(`${glyphs.cross} ${r.error.error.message}`);
    return;
  }
  if (!mountedRef.current) return;
  setFeedback(`${glyphs.check} removed "${target.title}"`);
  reload();
};

interface RunPublishTicketArgs {
  readonly target: Ticket;
  readonly sprintId: SprintId;
  readonly sprintRepo: TicketPublishDeps['sprintRepo'];
  readonly projectRepo: TicketPublishDeps['projectRepo'];
  readonly issuePusher: TicketPublishDeps['issuePusher'] | undefined;
  readonly mountedRef: RefObject<boolean>;
  readonly setFeedback: (message: string) => void;
  readonly reload: () => void;
}

/**
 * Run the ticket-publish flow for the focused ticket (the `p` chord) and thread the result to feedback.
 */
const runPublishTicket = async (args: RunPublishTicketArgs): Promise<void> => {
  const { target, sprintId, sprintRepo, projectRepo, issuePusher, mountedRef, setFeedback, reload } = args;
  if (issuePusher === undefined) {
    if (mountedRef.current) setFeedback(`${glyphs.cross} issue tracker is unavailable`);
    return;
  }
  const flow = createTicketPublishFlow({ sprintRepo, projectRepo, issuePusher });
  const r = await flow.execute({ input: { sprintId, ticketId: target.id } });
  if (!r.ok) {
    if (mountedRef.current) setFeedback(`${glyphs.cross} ${r.error.error.message}`);
    return;
  }
  if (!mountedRef.current) return;
  const out = r.value.ctx.output!;
  setFeedback(`${glyphs.check} ${out.outcome} "${target.title}"`);
  reload();
};

export interface BuildSprintDetailHandlersArgs {
  readonly sprint: Sprint | undefined;
  readonly deps: AppDeps;
  readonly focus: FocusModel;
  readonly queue: ReturnType<typeof usePromptQueue>;
  readonly edit: ReturnType<typeof useEditField>;
  readonly reload: () => void;
  readonly mountedRef: RefObject<boolean>;
  readonly setFeedback: (message: string) => void;
  readonly unblockTask: UnblockTask;
  readonly setConfirmRemove: (ticket: Ticket | undefined) => void;
  /** In-flight latch for `p`. */
  readonly publishInFlightRef: RefObject<boolean>;
}

export interface SprintDetailHandlers {
  readonly handleEdit: () => void;
  readonly handleUnblock: (task: Task) => Promise<void>;
  readonly handlePublish: (ticket: Ticket) => Promise<void>;
  readonly handleRemoveConfirmed: (target: Ticket, confirmed: boolean) => Promise<void>;
}

/** Build the `e` / `u` / `p` / confirmed-`d` handlers — thin wrappers over `runEdit` / `runUnblock` / `runPublishTicket` / `runRemoveTicket`. */
export const buildSprintDetailHandlers = (args: BuildSprintDetailHandlersArgs): SprintDetailHandlers => {
  const {
    sprint,
    deps,
    focus,
    queue,
    edit,
    reload,
    mountedRef,
    setFeedback,
    unblockTask,
    setConfirmRemove,
    publishInFlightRef,
  } = args;

  const handleEdit = (): void => {
    if (sprint === undefined) return;
    runEdit({
      sprint,
      focusedTicket: focus.focusedTicket,
      focusedTodoTask: focus.focusedTodoTask,
      queue,
      sprintRepo: deps.sprintRepo,
      taskRepo: deps.taskRepo,
      reload,
      openEditPrompt: edit.openEditPrompt,
    });
  };

  const handleUnblock = async (target: Task): Promise<void> => {
    if (sprint === undefined) return;
    await runUnblock({ target, sprintId: sprint.id, unblockTask, mountedRef, setFeedback, reload });
  };

  const handlePublish = async (target: Ticket): Promise<void> => {
    if (sprint === undefined || publishInFlightRef.current) return;
    publishInFlightRef.current = true;
    try {
      await runPublishTicket({
        target,
        sprintId: sprint.id,
        sprintRepo: deps.sprintRepo,
        projectRepo: deps.projectRepo,
        issuePusher: deps.issuePusher,
        mountedRef,
        setFeedback,
        reload,
      });
    } finally {
      publishInFlightRef.current = false;
    }
  };

  const handleRemoveConfirmed = async (target: Ticket, confirmed: boolean): Promise<void> => {
    setConfirmRemove(undefined);
    if (!confirmed || sprint === undefined) return;
    await runRemoveTicket({
      target,
      sprintId: sprint.id,
      sprintRepo: deps.sprintRepo,
      mountedRef,
      setFeedback,
      reload,
    });
  };

  return { handleEdit, handleUnblock, handlePublish, handleRemoveConfirmed };
};
