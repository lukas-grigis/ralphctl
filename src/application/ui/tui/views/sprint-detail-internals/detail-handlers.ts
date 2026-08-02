/**
 * Sprint detail — async action handlers.
 *
 * `buildSprintDetailHandlers` assembles the `e` / `u` / confirmed-`d` handlers `useSprintDetailBody`
 * wires into `useSprintDetailShortcuts`. `runUnblock` and `runRemoveTicket` are the underlying
 * async operations, split out as plain helpers so the mounted-ref guard is written once.
 */

import type { RefObject } from 'react';
import type { useEditField } from '@src/application/ui/tui/runtime/use-edit-field.ts';
import type { usePromptQueue } from '@src/application/ui/tui/prompts/prompt-context.tsx';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { Ticket } from '@src/domain/entity/ticket.ts';
import { glyphs } from '@src/application/ui/tui/theme/tokens.ts';
import { createTicketRemoveFlow } from '@src/application/flows/remove-ticket/flow.ts';
import type { TicketRemoveDeps } from '@src/application/flows/remove-ticket/deps.ts';
import type { UnblockTask } from '@src/application/ui/tui/runtime/use-unblock-task.ts';
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

/**
 * Run the unblock use case (via the shared `useUnblockTask` hook) for one stuck task (the `u`
 * chord) and thread the result to feedback + reload. `mountedRef` guards the post-await writes —
 * dismissing the confirm overlay (or firing `u`) unblocks the router, so the operator can
 * navigate away (unmounting the view) before the awaited use-case resolves.
 */
const runUnblock = async (args: RunUnblockArgs): Promise<void> => {
  const { target, sprintId, unblockTask, mountedRef, setFeedback, reload } = args;
  const r = await unblockTask(target, sprintId);
  if (!r.ok) {
    if (mountedRef.current) setFeedback(`${glyphs.cross} ${r.error.message}`);
    return;
  }
  if (!mountedRef.current) return;
  setFeedback(`${glyphs.check} unblocked "${target.name}"`);
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

/**
 * Run the ticket-remove flow for one confirmed removal and thread the result to feedback +
 * reload. Same `mountedRef` guard as {@link runUnblock} — the confirm overlay dismisses before
 * the flow resolves, so the view can already be unmounted by the time it settles.
 */
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
}

export interface SprintDetailHandlers {
  readonly handleEdit: () => void;
  readonly handleUnblock: (task: Task) => Promise<void>;
  readonly handleRemoveConfirmed: (target: Ticket, confirmed: boolean) => Promise<void>;
}

/** Build the `e` / `u` / confirmed-`d` handlers — thin wrappers over `runEdit` / `runUnblock` / `runRemoveTicket`. */
export const buildSprintDetailHandlers = (args: BuildSprintDetailHandlersArgs): SprintDetailHandlers => {
  const { sprint, deps, focus, queue, edit, reload, mountedRef, setFeedback, unblockTask, setConfirmRemove } = args;

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

  return { handleEdit, handleUnblock, handleRemoveConfirmed };
};
