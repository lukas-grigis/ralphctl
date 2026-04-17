import { getPrompt } from '@src/integration/bootstrap.ts';
import { listProjects } from '@src/integration/persistence/project.ts';
import { listSprints } from '@src/integration/persistence/sprint.ts';
import { formatTicketDisplay, listTickets } from '@src/integration/persistence/ticket.ts';
import { listTasks } from '@src/integration/persistence/task.ts';
import { formatSprintStatus, formatTaskStatus } from '@src/integration/ui/theme/ui.ts';
import { muted } from '@src/integration/ui/theme/theme.ts';
import type { SprintStatus, TaskStatus, Ticket } from '@src/domain/models.ts';
import { escapableSelect } from '@src/integration/ui/prompts/escapable.ts';

/**
 * Select a project from the list.
 * @returns project name or null if no projects exist
 */
export async function selectProject(message = 'Select project:'): Promise<string | null> {
  const projects = await listProjects();
  if (projects.length === 0) {
    console.log(muted('\nNo projects found.'));
    const create = await getPrompt().confirm({
      message: 'Create one now?',
      default: true,
    });
    if (create) {
      const { projectAddCommand } = await import('@src/integration/cli/commands/project/add.ts');
      await projectAddCommand({ interactive: true });
      // Re-check after creation
      const updated = await listProjects();
      if (updated.length === 0) return null;
      if (updated.length === 1 && updated[0]) return updated[0].name;
      // Fall through to selection below
      return escapableSelect({
        message,
        choices: updated.map((p) => ({
          name: p.displayName,
          value: p.name,
          description: p.description,
        })),
      });
    }
    return null;
  }

  return escapableSelect({
    message,
    choices: projects.map((p) => ({
      name: p.displayName,
      value: p.name,
      description: p.description,
    })),
  });
}

/**
 * Select a sprint from the list, optionally filtered by status.
 * @returns sprint ID or null if no matching sprints
 */
export async function selectSprint(message = 'Select sprint:', filter?: SprintStatus[]): Promise<string | null> {
  const sprints = await listSprints();
  const filtered = filter ? sprints.filter((s) => filter.includes(s.status)) : sprints;

  if (filtered.length === 0) {
    console.log(muted('\nNo sprints found.'));
    const create = await getPrompt().confirm({
      message: 'Create one now?',
      default: true,
    });
    if (create) {
      const { sprintCreateCommand } = await import('@src/integration/cli/commands/sprint/create.ts');
      await sprintCreateCommand({ interactive: true });
      // Re-check
      const updated = await listSprints();
      const refiltered = filter ? updated.filter((s) => filter.includes(s.status)) : updated;
      if (refiltered.length === 0) return null;
      if (refiltered.length === 1 && refiltered[0]) return refiltered[0].id;
      return escapableSelect({
        message,
        choices: refiltered.map((s) => ({
          name: `${s.id} - ${s.name} (${formatSprintStatus(s.status)})`,
          value: s.id,
        })),
      });
    }
    return null;
  }

  return escapableSelect({
    message,
    choices: filtered.map((s) => ({
      name: `${s.id} - ${s.name} (${formatSprintStatus(s.status)})`,
      value: s.id,
    })),
  });
}

/**
 * Select a ticket from the current sprint, optionally filtered.
 * @returns ticket ID or null if no tickets exist/match
 */
export async function selectTicket(
  message = 'Select ticket:',
  filter?: (t: Ticket) => boolean
): Promise<string | null> {
  const tickets = await listTickets();
  const filtered = filter ? tickets.filter(filter) : tickets;

  if (filtered.length === 0) {
    if (tickets.length === 0) {
      console.log(muted('\nNo tickets found.'));
      const create = await getPrompt().confirm({
        message: 'Add one now?',
        default: true,
      });
      if (create) {
        const { ticketAddCommand } = await import('@src/integration/cli/commands/ticket/add.ts');
        await ticketAddCommand({ interactive: true });
        // Re-check
        const updated = await listTickets();
        const refiltered = filter ? updated.filter(filter) : updated;
        if (refiltered.length === 0) return null;
        if (refiltered.length === 1 && refiltered[0]) return refiltered[0].id;
        return escapableSelect({
          message,
          choices: refiltered.map((t) => ({
            name: formatTicketDisplay(t),
            value: t.id,
          })),
        });
      }
      return null;
    }
    console.log(muted('\nNo matching tickets found.\n'));
    return null;
  }

  return escapableSelect({
    message,
    choices: filtered.map((t) => ({
      name: formatTicketDisplay(t),
      value: t.id,
    })),
  });
}

/**
 * Select a task from the current sprint, optionally filtered by status.
 * @returns task ID or null if no matching tasks
 */
export async function selectTask(message = 'Select task:', filter?: TaskStatus[]): Promise<string | null> {
  const tasks = await listTasks();
  const filtered = filter ? tasks.filter((t) => filter.includes(t.status)) : tasks;

  if (filtered.length === 0) {
    console.log(muted('\nNo tasks found. Use "sprint plan" to generate tasks.\n'));
    return null;
  }

  return escapableSelect({
    message,
    choices: filtered.map((t) => ({
      name: `${formatTaskStatus(t.status)} ${t.name}`,
      value: t.id,
    })),
  });
}

/**
 * Select a task status.
 * @returns task status
 */
export async function selectTaskStatus(message = 'Select status:'): Promise<TaskStatus | null> {
  const statuses: TaskStatus[] = ['todo', 'in_progress', 'done'];

  return escapableSelect({
    message,
    choices: statuses.map((s) => ({
      name: formatTaskStatus(s),
      value: s,
    })),
  });
}

/**
 * Prompt for a positive integer.
 * @returns the parsed number
 */
export async function inputPositiveInt(message: string): Promise<number> {
  const value = await getPrompt().input({
    message,
    validate: (v) => {
      const n = parseInt(v, 10);
      if (isNaN(n) || n < 1) return 'Must be a positive integer';
      return true;
    },
  });
  return parseInt(value, 10);
}
