/**
 * `ExportContextUseCase` — write the harness context (sprint + tickets +
 * tasks + check scripts + project info) to a markdown file.
 *
 * Mirrors the structure the AI session is fed during execution: a complete
 * snapshot of "everything the harness knows about this sprint right now".
 * Useful for sharing sprint state with humans or other tools.
 */
import type { DomainError } from '../../../domain/errors/domain-error.ts';
import type { ProjectRepository } from '../../../domain/repositories/project-repository.ts';
import type { SprintRepository } from '../../../domain/repositories/sprint-repository.ts';
import type { TaskRepository } from '../../../domain/repositories/task-repository.ts';
import { Result } from '../../../domain/result.ts';
import type { AbsolutePath } from '../../../domain/values/absolute-path.ts';
import type { SprintId } from '../../../domain/values/sprint-id.ts';
import { ValidationError } from '../../../domain/values/validation-error.ts';
import type { Project } from '../../../domain/entities/project.ts';
import type { Sprint } from '../../../domain/entities/sprint.ts';
import type { Task } from '../../../domain/entities/task.ts';
import type { WriteFileFn } from './export-requirements.ts';

export interface ExportContextInput {
  readonly sprintId: SprintId;
  readonly outputPath: AbsolutePath;
}

export interface ExportContextOutput {
  readonly path: AbsolutePath;
  readonly byteCount: number;
}

export class ExportContextUseCase {
  constructor(
    private readonly sprints: SprintRepository,
    private readonly tasks: TaskRepository,
    private readonly projects: ProjectRepository,
    private readonly writeFile: WriteFileFn
  ) {}

  async execute(input: ExportContextInput): Promise<Result<ExportContextOutput, DomainError>> {
    const sprintR = await this.sprints.findById(input.sprintId);
    if (!sprintR.ok) return Result.error(sprintR.error);
    const sprint = sprintR.value;

    const tasksR = await this.tasks.findBySprintId(sprint.id);
    if (!tasksR.ok) return Result.error(tasksR.error);

    const projectsR = await this.projects.list();
    if (!projectsR.ok) return Result.error(projectsR.error);

    const body = renderContextMarkdown({
      sprint,
      tasks: tasksR.value,
      projects: projectsR.value,
    });

    try {
      await this.writeFile(String(input.outputPath), body);
    } catch (err) {
      return Result.error(
        new ValidationError({
          field: 'outputPath',
          value: input.outputPath,
          message: `failed to write context file: ${err instanceof Error ? err.message : String(err)}`,
        })
      );
    }
    return Result.ok({
      path: input.outputPath,
      byteCount: Buffer.byteLength(body, 'utf-8'),
    });
  }
}

/** Pure markdown renderer — exposed for tests + previews. */
export function renderContextMarkdown(args: {
  readonly sprint: Sprint;
  readonly tasks: readonly Task[];
  readonly projects: readonly Project[];
}): string {
  const { sprint, tasks, projects } = args;
  const lines: string[] = [];

  // Sprint summary.
  lines.push(`# Harness Context — ${sprint.name}`);
  lines.push('');
  lines.push(`- Sprint id: \`${String(sprint.id)}\``);
  lines.push(`- Status: ${sprint.status}`);
  if (sprint.branch !== null) lines.push(`- Branch: \`${sprint.branch}\``);
  lines.push(`- Tickets: ${String(sprint.tickets.length)}`);
  lines.push(`- Tasks: ${String(tasks.length)}`);
  lines.push('');

  // Projects + repositories.
  lines.push('## Projects');
  lines.push('');
  if (projects.length === 0) {
    lines.push('_(no projects registered)_');
  } else {
    for (const project of projects) {
      lines.push(`### ${String(project.name)} — ${project.displayName}`);
      lines.push('');
      if (project.description !== undefined) lines.push(project.description);
      lines.push('');
      for (const repo of project.repositories) {
        lines.push(`- \`${String(repo.path)}\` (${repo.name})`);
        if (repo.checkScript !== undefined) {
          lines.push(`  - check: \`${repo.checkScript}\``);
        }
        if (repo.setupScript !== undefined) {
          lines.push(`  - setup: \`${repo.setupScript}\``);
        }
      }
      lines.push('');
    }
  }

  // Tickets.
  lines.push('## Tickets');
  lines.push('');
  if (sprint.tickets.length === 0) {
    lines.push('_(no tickets)_');
  } else {
    for (const ticket of sprint.tickets) {
      lines.push(`### ${ticket.title}`);
      lines.push('');
      lines.push(`- ID: \`${String(ticket.id)}\``);
      lines.push(`- Project: ${String(ticket.projectName)}`);
      lines.push(`- Status: ${ticket.requirementStatus}`);
      if (ticket.link !== undefined) lines.push(`- Link: ${ticket.link}`);
      if (ticket.description !== undefined) {
        lines.push('');
        lines.push(ticket.description);
      }
      if (ticket.requirements !== undefined && ticket.requirements.length > 0) {
        lines.push('');
        lines.push('**Requirements:**');
        lines.push('');
        lines.push(ticket.requirements);
      }
      lines.push('');
    }
  }

  // Tasks.
  lines.push('## Tasks');
  lines.push('');
  if (tasks.length === 0) {
    lines.push('_(no tasks generated yet — run `ralphctl sprint plan`)_');
  } else {
    for (const task of tasks) {
      lines.push(`### ${String(task.order)}. ${task.name}`);
      lines.push('');
      lines.push(`- ID: \`${String(task.id)}\``);
      lines.push(`- Status: ${task.status}`);
      lines.push(`- Project path: \`${String(task.projectPath)}\``);
      if (task.ticketId !== undefined) lines.push(`- Ticket: \`${String(task.ticketId)}\``);
      if (task.blockedBy.length > 0) {
        lines.push(`- Blocked by: ${task.blockedBy.map((id) => '`' + String(id) + '`').join(', ')}`);
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
  }

  return lines.join('\n');
}
