/**
 * `task edit` — edit a todo task's mutable fields.
 *
 * Locked once the task starts running — only `todo` tasks can be edited.
 * Use empty-string flags (`--description ''`, `--extra-dimensions ''`) to
 * clear those fields.
 */
import type { Command } from 'commander';
import * as c from 'colorette';

import { EditTaskUseCase } from '@src/business/usecases/task/edit-task.ts';
import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import { SprintId } from '@src/domain/values/sprint-id.ts';
import { TaskId } from '@src/domain/values/task-id.ts';
import type { SharedDeps } from '@src/application/bootstrap/shared-deps.ts';
import { parseId, runCommand } from '@src/application/cli/command-runner.ts';
import { EXIT_SUCCESS, type ExitCode } from '@src/application/cli/exit-codes.ts';

interface TaskEditFlags {
  readonly sprint: string;
  readonly task: string;
  readonly name?: string;
  readonly description?: string;
  readonly steps?: string[];
  readonly verificationCriteria?: string[];
  readonly blockedBy?: string[];
  readonly projectPath?: string;
  readonly extraDimensions?: string;
}

export function attachTaskEdit(group: Command, deps: SharedDeps): void {
  group
    .command('edit')
    .description('edit fields on a todo task')
    .requiredOption('--sprint <id>', 'sprint id')
    .requiredOption('--task <id>', 'task id')
    .option('--name <text>', 'new task name')
    .option('--description <text>', "new description (use '' to clear)")
    .option('--steps <step...>', 'replacement step list (repeat the flag)')
    .option('--verification-criteria <criterion...>', 'replacement verification list (repeat the flag)')
    .option('--blocked-by <id...>', 'replacement blockedBy list (repeat the flag)')
    .option('--project-path <path>', "absolute path to the task's project repo")
    .option('--extra-dimensions <csv>', "comma-separated extra evaluator dimensions ('' clears)")
    .action(async (opts: TaskEditFlags) => {
      const code = await runTaskEdit(deps, opts);
      if (code !== EXIT_SUCCESS) process.exitCode = code;
    });
}

export async function runTaskEdit(deps: SharedDeps, opts: TaskEditFlags): Promise<ExitCode> {
  return runCommand({
    deps,
    body: async () => {
      const sprintId = parseId(SprintId, opts.sprint);
      if (!sprintId.ok) return sprintId;
      const taskId = parseId(TaskId, opts.task);
      if (!taskId.ok) return taskId;

      let projectPath;
      if (opts.projectPath !== undefined) {
        const parsed = parseId(AbsolutePath, opts.projectPath);
        if (!parsed.ok) return parsed;
        projectPath = parsed.value;
      }

      const blockedBy: TaskId[] = [];
      if (opts.blockedBy !== undefined) {
        for (const raw of opts.blockedBy) {
          const parsedDep = parseId(TaskId, raw);
          if (!parsedDep.ok) return parsedDep;
          blockedBy.push(parsedDep.value);
        }
      }

      let extraDimensions: readonly string[] | null | undefined;
      if (opts.extraDimensions !== undefined) {
        const trimmed = opts.extraDimensions.trim();
        extraDimensions =
          trimmed === ''
            ? null
            : trimmed
                .split(',')
                .map((s) => s.trim())
                .filter((s) => s.length > 0);
      }

      const useCase = new EditTaskUseCase(deps.taskRepo);
      return useCase.execute({
        sprintId: sprintId.value,
        taskId: taskId.value,
        ...(opts.name !== undefined ? { name: opts.name } : {}),
        ...(opts.description !== undefined ? { description: opts.description === '' ? null : opts.description } : {}),
        ...(opts.steps !== undefined ? { steps: opts.steps } : {}),
        ...(opts.verificationCriteria !== undefined ? { verificationCriteria: opts.verificationCriteria } : {}),
        ...(opts.blockedBy !== undefined ? { blockedBy } : {}),
        ...(projectPath !== undefined ? { projectPath } : {}),
        ...(extraDimensions !== undefined ? { extraDimensions } : {}),
      });
    },
    format: (_d, task) => `${c.green('updated')} task ${c.bold(task.id)} — ${task.name}`,
  });
}
