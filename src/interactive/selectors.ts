import { checkbox, input, select } from '@inquirer/prompts';
import { listProjects } from '@src/store/project.ts';
import { listSprints } from '@src/store/sprint.ts';
import { formatTicketDisplay, listTickets } from '@src/store/ticket.ts';
import { listTasks } from '@src/store/task.ts';
import { emoji, formatSprintStatus, formatTaskStatus } from '@src/theme/ui.ts';
import { muted } from '@src/theme/index.ts';
import type { Repository, SprintStatus, TaskStatus } from '@src/schemas/index.ts';

/**
 * Select a project from the list.
 * @returns project name or null if no projects exist
 */
export async function selectProject(message = 'Select project:'): Promise<string | null> {
  const projects = await listProjects();
  if (projects.length === 0) {
    console.log(muted('\nNo projects found.\n'));
    return null;
  }

  return select({
    message: `${emoji.donut} ${message}`,
    choices: projects.map((p) => ({
      name: p.displayName,
      value: p.name,
      description: p.description,
    })),
  });
}

/**
 * Select a project and then a repository within it.
 * Auto-selects if only one option available at each step.
 * @returns repository path or null if no projects exist
 */
export async function selectProjectRepository(message = 'Select repository:'): Promise<string | null> {
  const projects = await listProjects();
  if (projects.length === 0) {
    console.log(muted('\nNo projects found.\n'));
    return null;
  }

  // Step 1: Select project (auto-select if only one)
  let projectName: string;
  const firstProject = projects[0];
  if (projects.length === 1 && firstProject) {
    projectName = firstProject.name;
  } else {
    projectName = await select({
      message: `${emoji.donut} Select project:`,
      choices: projects.map((p) => ({
        name: p.displayName,
        value: p.name,
        description: `${String(p.repositories.length)} repo(s)`,
      })),
    });
  }

  const project = projects.find((p) => p.name === projectName);
  if (!project) {
    return null;
  }

  // Step 2: Select repository (auto-select if only one)
  const firstRepo = project.repositories[0];
  if (project.repositories.length === 1 && firstRepo) {
    return firstRepo.path;
  }

  return select({
    message: `${emoji.donut} ${message}`,
    choices: project.repositories.map((r) => ({
      name: r.name,
      value: r.path,
      description: r.path,
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
    console.log(muted('\nNo sprints found.\n'));
    return null;
  }

  return select({
    message: `${emoji.donut} ${message}`,
    choices: filtered.map((s) => ({
      name: `${s.id} - ${s.name} (${formatSprintStatus(s.status)})`,
      value: s.id,
    })),
  });
}

/**
 * Select a ticket from the current sprint.
 * @returns ticket ID or null if no tickets exist
 */
export async function selectTicket(message = 'Select ticket:'): Promise<string | null> {
  const tickets = await listTickets();
  if (tickets.length === 0) {
    console.log(muted('\nNo tickets found.\n'));
    return null;
  }

  return select({
    message: `${emoji.donut} ${message}`,
    choices: tickets.map((t) => ({
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
    console.log(muted('\nNo tasks found.\n'));
    return null;
  }

  return select({
    message: `${emoji.donut} ${message}`,
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
export async function selectTaskStatus(message = 'Select status:'): Promise<TaskStatus> {
  const statuses: TaskStatus[] = ['todo', 'in_progress', 'done'];

  return select({
    message: `${emoji.donut} ${message}`,
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
  const value = await input({
    message: `${emoji.donut} ${message}`,
    validate: (v) => {
      const n = parseInt(v, 10);
      if (isNaN(n) || n < 1) return 'Must be a positive integer';
      return true;
    },
  });
  return parseInt(value, 10);
}

/**
 * Select project repositories for Claude to explore.
 * First repository per project is pre-selected by default.
 */
export async function selectProjectPaths(
  reposByProject: Map<string, Repository[]>,
  message = 'Select paths for Claude to explore:'
): Promise<string[]> {
  const choices: { name: string; value: string; checked: boolean }[] = [];

  for (const [projectName, repos] of reposByProject) {
    repos.forEach((repo, i) => {
      choices.push({
        name: `[${projectName}] ${repo.name} (${repo.path})`,
        value: repo.path,
        checked: i === 0, // First repo per project pre-selected
      });
    });
  }

  return checkbox({ message: `${emoji.donut} ${message}`, choices });
}
