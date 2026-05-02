/**
 * `task add` — append a task to a sprint's task list.
 *
 * Useful for direct task entry (skipping the AI plan flow). The use case
 * auto-assigns `order` when omitted.
 */
import type { Command } from 'commander';
import * as c from 'colorette';

import { AddTaskUseCase } from '@src/business/usecases/task/add-task.ts';
import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import { SprintId } from '@src/domain/values/sprint-id.ts';
import type { SharedDeps } from '@src/application/bootstrap/shared-deps.ts';
import { parseId, runCommand } from '@src/application/cli/command-runner.ts';
import { EXIT_SUCCESS, type ExitCode } from '@src/application/cli/exit-codes.ts';

interface TaskAddFlags {
  readonly sprint: string;
  readonly name: string;
  readonly projectPath: string;
  readonly description?: string;
  readonly order?: string;
  readonly step?: string[];
  readonly criterion?: string[];
}

export function attachTaskAdd(group: Command, deps: SharedDeps): void {
  group
    .command('add')
    .description('add a task directly to a sprint')
    .requiredOption('--sprint <id>', 'sprint id')
    .requiredOption('--name <text>', 'task name')
    .requiredOption('--project-path <abs>', 'absolute path the task runs in')
    .option('--description <text>', 'optional description')
    .option('--order <n>', 'explicit 1-indexed order (auto-assigned if omitted)')
    .option('--step <text...>', 'task step (repeatable)')
    .option('--criterion <text...>', 'verification criterion (repeatable)')
    .action(async (opts: TaskAddFlags) => {
      const code = await runTaskAdd(deps, opts);
      if (code !== EXIT_SUCCESS) process.exitCode = code;
    });
}

export async function runTaskAdd(deps: SharedDeps, opts: TaskAddFlags): Promise<ExitCode> {
  return runCommand({
    deps,
    body: async () => {
      const sprintId = parseId(SprintId, opts.sprint);
      if (!sprintId.ok) return sprintId;
      const projectPath = parseId(AbsolutePath, opts.projectPath);
      if (!projectPath.ok) return projectPath;

      const order = opts.order !== undefined ? Number.parseInt(opts.order, 10) : undefined;
      const useCase = new AddTaskUseCase(deps.taskRepo);
      return useCase.execute({
        sprintId: sprintId.value,
        taskInput: {
          name: opts.name,
          projectPath: projectPath.value,
          steps: opts.step ?? [],
          verificationCriteria: opts.criterion ?? [],
          ...(opts.description !== undefined ? { description: opts.description } : {}),
          ...(order !== undefined ? { order } : {}),
        },
      });
    },
    format: (_d, tasks) => {
      const last = tasks[tasks.length - 1];
      return last ? `${c.green('added task')} ${c.bold(last.id)} (#${String(last.order)})` : c.green('added task');
    },
  });
}
