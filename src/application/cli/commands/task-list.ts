/**
 * `task list --sprint <id>` — enumerate a sprint's tasks.
 */
import type { Command } from 'commander';
import * as c from 'colorette';

import { ListTasksUseCase } from '../../../business/usecases/task/list-tasks.ts';
import { Result } from '../../../domain/result.ts';
import { SprintId } from '../../../domain/values/sprint-id.ts';
import type { SharedDeps } from '../../bootstrap/shared-deps.ts';
import { runCommand } from '../command-runner.ts';
import { EXIT_SUCCESS, type ExitCode } from '../exit-codes.ts';
import { formatTaskLine } from '../format/format-task.ts';

interface TaskListFlags {
  readonly sprint: string;
}

export function attachTaskList(group: Command, deps: SharedDeps): void {
  group
    .command('list')
    .description('list tasks in a sprint')
    .requiredOption('--sprint <id>', 'sprint id')
    .action(async (opts: TaskListFlags) => {
      const code = await runTaskList(deps, opts);
      if (code !== EXIT_SUCCESS) process.exitCode = code;
    });
}

export async function runTaskList(deps: SharedDeps, opts: TaskListFlags): Promise<ExitCode> {
  return runCommand({
    deps,
    body: async () => {
      const sprintId = SprintId.parse(opts.sprint);
      if (!sprintId.ok) return Result.error(sprintId.error);
      return new ListTasksUseCase(deps.taskRepo).execute({ sprintId: sprintId.value });
    },
    format: (_d, tasks) => {
      if (tasks.length === 0) return c.dim('  (no tasks)');
      const sorted = [...tasks].sort((a, b) => a.order - b.order);
      return [c.bold('Tasks'), ...sorted.map(formatTaskLine)].join('\n');
    },
  });
}
