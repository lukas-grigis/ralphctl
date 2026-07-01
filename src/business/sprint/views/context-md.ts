import type { Project } from '@src/domain/entity/project.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { Ticket } from '@src/domain/entity/ticket.ts';

export interface RenderSprintContextInput {
  readonly sprint: Sprint;
  readonly project: Project;
  readonly tasks: readonly Task[];
}

/**
 * Pure renderer — turn the full harness context (sprint + tickets + tasks + project + repos) into
 * a markdown document. Mirrors what the AI sees during execution, useful for sharing sprint state
 * with humans or other tools.
 *
 * One project (the sprint's target), not the full registry — v1 listed every project on the
 * machine, which leaked unrelated state into the export. v2 keeps the export scoped to the
 * sprint at hand.
 */
export const renderSprintContextMarkdown = (input: RenderSprintContextInput): string => {
  const { sprint, project, tasks } = input;
  const lines: string[] = [];

  lines.push(...renderHeaderLines(sprint, tasks));
  lines.push(...renderProjectLines(project));
  lines.push(...renderTicketsLines(sprint.tickets));
  lines.push(...renderTasksLines(tasks));

  return lines.join('\n');
};

const renderHeaderLines = (sprint: Sprint, tasks: readonly Task[]): string[] => {
  return [
    `# Harness Context — ${sprint.name}`,
    '',
    `- Sprint id: \`${String(sprint.id)}\``,
    `- Slug: \`${String(sprint.slug)}\``,
    `- Status: ${sprint.status}`,
    `- Tickets: ${String(sprint.tickets.length)}`,
    `- Tasks: ${String(tasks.length)}`,
    '',
  ];
};

const renderProjectLines = (project: Project): string[] => {
  const lines: string[] = [];

  lines.push('## Project');
  lines.push('');
  lines.push(`### ${project.displayName} — \`${String(project.slug)}\``);
  lines.push('');
  if (project.description !== undefined) {
    lines.push(project.description);
    lines.push('');
  }
  if (project.repositories.length === 0) {
    lines.push('_(no repositories registered)_');
  } else {
    for (const repo of project.repositories) {
      lines.push(`- \`${String(repo.path)}\` (${repo.name})`);
      if (repo.verifyScript !== undefined) lines.push(`  - verify: \`${repo.verifyScript}\``);
      if (repo.setupScript !== undefined) lines.push(`  - setup: \`${repo.setupScript}\``);
    }
  }
  lines.push('');

  return lines;
};

const renderTicketsLines = (tickets: readonly Ticket[]): string[] => {
  const lines: string[] = [];

  lines.push('## Tickets');
  lines.push('');
  if (tickets.length === 0) {
    lines.push('_(no tickets)_');
    lines.push('');
  } else {
    for (const ticket of tickets) {
      lines.push(`### ${ticket.title}`);
      lines.push('');
      lines.push(`- ID: \`${String(ticket.id)}\``);
      lines.push(`- Status: ${ticket.status}`);
      if (ticket.link !== undefined) lines.push(`- Link: ${String(ticket.link)}`);
      if (ticket.description !== undefined) {
        lines.push('');
        lines.push(ticket.description);
      }
      if (ticket.status === 'approved') {
        lines.push('');
        lines.push('**Requirements:**');
        lines.push('');
        lines.push(ticket.requirements);
      }
      lines.push('');
    }
  }

  return lines;
};

const renderTaskLines = (task: Task): string[] => {
  const lines: string[] = [];

  lines.push(`### ${String(task.order)}. ${task.name}`);
  lines.push('');
  lines.push(`- ID: \`${String(task.id)}\``);
  lines.push(`- Status: ${task.status}`);
  lines.push(`- Ticket: \`${String(task.ticketId)}\``);
  if (task.dependsOn.length > 0) {
    lines.push(`- Depends on: ${task.dependsOn.map((id) => `\`${String(id)}\``).join(', ')}`);
  }
  if (task.description !== undefined) {
    lines.push('');
    lines.push(task.description);
  }
  if (task.steps.length > 0) {
    lines.push('');
    lines.push('**Steps:**');
    for (const step of task.steps) lines.push(`- ${step}`);
  }
  if (task.verificationCriteria.length > 0) {
    lines.push('');
    lines.push('**Verification:**');
    for (const vc of task.verificationCriteria) {
      if (vc.check === 'auto' && vc.command !== undefined) {
        lines.push(`- [${vc.id}] auto \`${vc.command}\` — ${vc.assertion}`);
      } else {
        lines.push(`- [${vc.id}] manual — ${vc.assertion}`);
      }
    }
  }
  lines.push('');

  return lines;
};

const renderTasksLines = (tasks: readonly Task[]): string[] => {
  const lines: string[] = [];

  lines.push('## Tasks');
  lines.push('');
  if (tasks.length === 0) {
    lines.push('_(no tasks generated yet — run `ralphctl sprint plan`)_');
    lines.push('');
    return lines;
  }

  const sortedTasks = [...tasks].sort((a, b) => a.order - b.order);
  for (const task of sortedTasks) {
    lines.push(...renderTaskLines(task));
  }

  return lines;
};
