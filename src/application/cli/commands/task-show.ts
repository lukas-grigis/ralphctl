/**
 * `task show` — render a single task's full card.
 */
import type { Command } from 'commander';

import { ShowTaskUseCase } from '../../../business/usecases/task/show-task.ts';
import { Result } from '../../../domain/result.ts';
import { SprintId } from '../../../domain/values/sprint-id.ts';
import { TaskId } from '../../../domain/values/task-id.ts';
import type { SharedDeps } from '../../bootstrap/shared-deps.ts';
import { runCommand } from '../command-runner.ts';
import { EXIT_SUCCESS, type ExitCode } from '../exit-codes.ts';
import { formatTaskCard } from '../format/format-task.ts';

interface TaskShowFlags {
  readonly sprint: string;
  readonly task: string;
}

export function attachTaskShow(group: Command, deps: SharedDeps): void {
  group
    .command('show')
    .description('show a task by id')
    .requiredOption('--sprint <id>', 'sprint id')
    .requiredOption('--task <id>', 'task id')
    .action(async (opts: TaskShowFlags) => {
      const code = await runTaskShow(deps, opts);
      if (code !== EXIT_SUCCESS) process.exitCode = code;
    });
}

export async function runTaskShow(deps: SharedDeps, opts: TaskShowFlags): Promise<ExitCode> {
  return runCommand({
    deps,
    body: async () => {
      const sprintId = SprintId.parse(opts.sprint);
      if (!sprintId.ok) return Result.error(sprintId.error);
      const taskId = TaskId.parse(opts.task);
      if (!taskId.ok) return Result.error(taskId.error);
      return new ShowTaskUseCase(deps.taskRepo).execute({
        sprintId: sprintId.value,
        taskId: taskId.value,
      });
    },
    format: (_d, task) => formatTaskCard(task),
  });
}
