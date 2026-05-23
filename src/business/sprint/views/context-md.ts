import type { Project } from '@src/domain/entity/project.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { Task } from '@src/domain/entity/task.ts';

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

  lines.push(`# Harness Context — ${sprint.name}`);
  lines.push('');
  lines.push(`- Sprint id: \`${String(sprint.id)}\``);
  lines.push(`- Slug: \`${String(sprint.slug)}\``);
  lines.push(`- Status: ${sprint.status}`);
  lines.push(`- Tickets: ${String(sprint.tickets.length)}`);
  lines.push(`- Tasks: ${String(tasks.length)}`);
  lines.push('');

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

  lines.push('## Tickets');
  lines.push('');
  if (sprint.tickets.length === 0) {
    lines.push('_(no tickets)_');
    lines.push('');
  } else {
    for (const ticket of sprint.tickets) {
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

  lines.push('## Tasks');
  lines.push('');
  if (tasks.length === 0) {
    lines.push('_(no tasks generated yet — run `ralphctl sprint plan`)_');
    lines.push('');
    return lines.join('\n');
  }

  const sortedTasks = [...tasks].sort((a, b) => a.order - b.order);
  for (const task of sortedTasks) {
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
      for (const vc of task.verificationCriteria) lines.push(`- ${vc}`);
    }
    lines.push('');
  }

  return lines.join('\n');
};
