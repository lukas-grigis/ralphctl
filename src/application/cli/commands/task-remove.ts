/**
 * `task remove` — drop a task from a sprint.
 */
import type { Command } from 'commander';
import * as c from 'colorette';

import { RemoveTaskUseCase } from '../../../business/usecases/task/remove-task.ts';
import { SprintId } from '../../../domain/values/sprint-id.ts';
import { TaskId } from '../../../domain/values/task-id.ts';
import type { SharedDeps } from '../../bootstrap/shared-deps.ts';
import { parseId, runCommand } from '../command-runner.ts';
import { EXIT_SUCCESS, type ExitCode } from '../exit-codes.ts';

interface TaskRemoveFlags {
  readonly sprint: string;
  readonly task: string;
}

export function attachTaskRemove(group: Command, deps: SharedDeps): void {
  group
    .command('remove')
    .description('drop a task from a sprint')
    .requiredOption('--sprint <id>', 'sprint id')
    .requiredOption('--task <id>', 'task id')
    .action(async (opts: TaskRemoveFlags) => {
      const code = await runTaskRemove(deps, opts);
      if (code !== EXIT_SUCCESS) process.exitCode = code;
    });
}

export async function runTaskRemove(deps: SharedDeps, opts: TaskRemoveFlags): Promise<ExitCode> {
  return runCommand({
    deps,
    body: async () => {
      const sprintId = parseId(SprintId, opts.sprint);
      if (!sprintId.ok) return sprintId;
      const taskId = parseId(TaskId, opts.task);
      if (!taskId.ok) return taskId;
      return new RemoveTaskUseCase(deps.taskRepo).execute({
        sprintId: sprintId.value,
        taskId: taskId.value,
      });
    },
    format: () => `${c.green('removed task')} ${c.bold(opts.task)}`,
  });
}
