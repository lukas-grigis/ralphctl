import { Result } from '@src/domain/result.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintExecution } from '@src/domain/entity/sprint-execution.ts';
import type { Task } from '@src/domain/entity/task.ts';
import { type TaskGraphIssue, validateTaskGraph } from '@src/domain/entity/task-graph.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';

export interface SprintConsistencyInput {
  readonly project: Project;
  readonly sprint: Sprint;
  readonly execution: SprintExecution;
  readonly tasks: readonly Task[];
}

/**
 * Cross-aggregate pre-flight check. Asserts every reference in the sprint subgraph resolves
 * inside the supplied bundle:
 *
 *  1. `sprint.projectId === project.id`
 *  2. `execution.sprintId === sprint.id`
 *  3. every `task.ticketId` exists in `sprint.tickets`
 *  4. every `task.repositoryId` exists in `project.repositories`
 *  5. `validateTaskGraph(tasks)` passes (no cycles, no self-edges, no unknown deps)
 *
 * Single failure surfaces the first problem found — callers fix one thing, re-run, fix the next.
 * Domain code stays pure: no repository fetches, no I/O.
 */
export const validateSprintConsistency = (
  input: SprintConsistencyInput
): Result<undefined, ValidationError | TaskGraphIssue> => {
  const { project, sprint, execution, tasks } = input;

  if (sprint.projectId !== project.id) {
    return Result.error(
      new ValidationError({
        field: 'sprint.projectId',
        value: sprint.projectId,
        message: `sprint '${sprint.id}' targets project '${sprint.projectId}' but received project '${project.id}' (slug '${project.slug}')`,
      })
    );
  }

  if (execution.sprintId !== sprint.id) {
    return Result.error(
      new ValidationError({
        field: 'sprint-execution.sprintId',
        value: execution.sprintId,
        message: `execution.sprintId '${execution.sprintId}' does not match sprint.id '${sprint.id}'`,
      })
    );
  }

  const ticketIds = new Set(sprint.tickets.map((t) => t.id));
  const repositoryIds = new Set(project.repositories.map((r) => r.id));

  for (const task of tasks) {
    if (!ticketIds.has(task.ticketId)) {
      return Result.error(
        new ValidationError({
          field: 'task.ticketId',
          value: task.ticketId,
          message: `task '${task.id}' references unknown ticket '${task.ticketId}' on sprint '${sprint.id}'`,
        })
      );
    }
    if (!repositoryIds.has(task.repositoryId)) {
      return Result.error(
        new ValidationError({
          field: 'task.repositoryId',
          value: task.repositoryId,
          message: `task '${task.id}' references unknown repository '${task.repositoryId}' on project '${project.slug}'`,
        })
      );
    }
  }

  return validateTaskGraph(tasks);
};
