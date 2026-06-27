/**
 * Edit-field prompt builders for ticket and task fields.
 *
 * Each builder returns an `OpenEditPromptInput` describing the modal (title, kind, initial
 * value, save handler, success label) for one field on one entity. The shared `runEdit` helper
 * routes the user through a choice prompt to pick which field to edit and then opens the modal.
 *
 * Lives outside the view file so the orchestrator's render path doesn't carry the ~120 LOC of
 * edit machinery that has no rendering concerns of its own.
 */

import { Result } from '@src/domain/result.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import { replaceTicket } from '@src/domain/entity/sprint.ts';
import type { Ticket } from '@src/domain/entity/ticket.ts';
import {
  type ApprovedTicket,
  setTicketDescription,
  setTicketRequirements,
  setTicketTitle,
} from '@src/domain/entity/ticket.ts';
import { updateTask } from '@src/domain/entity/task-factory.ts';
import type { OpenEditPromptInput } from '@src/application/ui/tui/runtime/use-edit-field.ts';
import type { PromptQueue } from '@src/application/ui/tui/prompts/prompt-queue.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { TaskRepository } from '@src/domain/repository/task/task-repository.ts';

type TicketFieldKey = 'title' | 'description' | 'requirements';
type TaskFieldKey = 'name' | 'description';

interface BuildTicketEditArgs {
  readonly sprint: Sprint;
  readonly ticket: Ticket;
  readonly field: TicketFieldKey;
  readonly sprintRepo: Pick<SprintRepository, 'save'>;
  readonly reload: () => void;
}

export const buildTicketEdit = (args: BuildTicketEditArgs): OpenEditPromptInput | undefined => {
  const { sprint, ticket, field, sprintRepo, reload } = args;
  if (field === 'requirements' && ticket.status !== 'approved') {
    return undefined;
  }
  const current =
    field === 'title'
      ? ticket.title
      : field === 'description'
        ? (ticket.description ?? '')
        : (ticket as ApprovedTicket).requirements;
  return {
    title: `Edit ticket ${field} — "${ticket.title}"`,
    kind: field === 'title' ? 'short' : 'long',
    currentValue: current,
    onSave: async (value) => {
      const updated =
        field === 'title'
          ? setTicketTitle(ticket, value)
          : field === 'description'
            ? setTicketDescription(ticket, value.length === 0 ? undefined : value)
            : ticket.status === 'approved'
              ? setTicketRequirements(ticket, value)
              : Result.ok(ticket);
      if (!updated.ok) return Result.error(updated.error);
      const replaced = replaceTicket(sprint, ticket.id, updated.value);
      if (!replaced.ok) return Result.error(replaced.error);
      const saved = await sprintRepo.save(replaced.value);
      if (!saved.ok) return Result.error(saved.error);
      reload();
      return Result.ok(undefined);
    },
    successLabel: `✓ updated ticket ${field}`,
  };
};

interface BuildTaskEditArgs {
  readonly sprint: Sprint;
  readonly task: Task;
  readonly field: TaskFieldKey;
  readonly taskRepo: Pick<TaskRepository, 'update'>;
  readonly reload: () => void;
}

export const buildTaskEdit = (args: BuildTaskEditArgs): OpenEditPromptInput | undefined => {
  const { sprint, task, field, taskRepo, reload } = args;
  if (task.status !== 'todo') return undefined;
  const current = field === 'name' ? task.name : (task.description ?? '');
  return {
    title: `Edit task ${field} — "${task.name}"`,
    kind: field === 'name' ? 'short' : 'long',
    currentValue: current,
    onSave: async (value) => {
      const update = field === 'name' ? { name: value } : { description: value.length === 0 ? null : value };
      const next = updateTask(task, update);
      if (!next.ok) return Result.error(next.error);
      const saved = await taskRepo.update(sprint.id, next.value);
      if (!saved.ok) return Result.error(saved.error);
      reload();
      return Result.ok(undefined);
    },
    successLabel: `✓ updated task ${field}`,
  };
};

interface RunEditArgs {
  readonly sprint: Sprint;
  readonly focusedTicket: Ticket | undefined;
  readonly focusedTodoTask: Task | undefined;
  readonly queue: PromptQueue;
  readonly sprintRepo: Pick<SprintRepository, 'save'>;
  readonly taskRepo: Pick<TaskRepository, 'update'>;
  readonly reload: () => void;
  readonly openEditPrompt: (cfg: OpenEditPromptInput) => Promise<unknown>;
}

/**
 * Drive the edit flow end-to-end: if the user has a ticket focused, prompt them to pick a
 * field and open the corresponding modal; if a todo task is focused, do the same for the task
 * fields. The non-zero-options gate routes single-option tickets straight to the title editor
 * without bouncing the user through a one-choice prompt.
 */
export const runEdit = (args: RunEditArgs): void => {
  const { sprint, focusedTicket, focusedTodoTask, queue, sprintRepo, taskRepo, reload, openEditPrompt } = args;
  if (focusedTicket !== undefined) {
    const options: ReadonlyArray<{ readonly label: string; readonly value: TicketFieldKey }> = [
      { label: 'title', value: 'title' },
      { label: 'description', value: 'description' },
      ...(focusedTicket.status === 'approved'
        ? ([{ label: 'requirements', value: 'requirements' as const }] as const)
        : []),
    ];
    if (options.length === 1) {
      const cfg = buildTicketEdit({ sprint, ticket: focusedTicket, field: 'title', sprintRepo, reload });
      if (cfg !== undefined) void openEditPrompt(cfg);
      return;
    }
    new Promise<TicketFieldKey>((resolve, reject) => {
      queue.enqueue({ kind: 'choice', message: 'Edit which ticket field?', options, resolve, reject });
    })
      .then((field) => {
        const cfg = buildTicketEdit({ sprint, ticket: focusedTicket, field, sprintRepo, reload });
        if (cfg !== undefined) void openEditPrompt(cfg);
      })
      .catch((cause: unknown) => {
        if (cause instanceof AbortError) throw cause;
        return undefined;
      });
    return;
  }
  if (focusedTodoTask !== undefined) {
    const options: ReadonlyArray<{ readonly label: string; readonly value: TaskFieldKey }> = [
      { label: 'name', value: 'name' },
      { label: 'description', value: 'description' },
    ];
    new Promise<TaskFieldKey>((resolve, reject) => {
      queue.enqueue({ kind: 'choice', message: 'Edit which task field?', options, resolve, reject });
    })
      .then((field) => {
        const cfg = buildTaskEdit({ sprint, task: focusedTodoTask, field, taskRepo, reload });
        if (cfg !== undefined) void openEditPrompt(cfg);
      })
      .catch((cause: unknown) => {
        if (cause instanceof AbortError) throw cause;
        return undefined;
      });
  }
};
