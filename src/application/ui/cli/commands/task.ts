import type { Command } from 'commander';
import type { Task } from '@src/domain/entity/task.ts';
import { TaskId } from '@src/domain/value/id/task-id.ts';
import { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { bootstrapCli } from '@src/application/ui/cli/bootstrap.ts';

interface SprintOpt {
  readonly sprint: string;
}

/**
 * Register the `task` command group. Read-side only — task creation is owned by the planning
 * chain (AI generates the task graph from approved tickets); manual `task add` / `task edit`
 * are deferred until there's a concrete UX for tweaking AI-generated plans.
 *
 *   ralphctl task list --sprint <id>
 *   ralphctl task show --sprint <id> <task-id>
 */
export const registerTaskCommand = (program: Command): void => {
  const task = program.command('task').description('inspect tasks for a sprint (planning generates them)');

  task
    .command('list')
    .description('list every task on the sprint, in order')
    .requiredOption('-s, --sprint <id>', 'sprint id')
    .action(async (opts: SprintOpt) => {
      const sprintId = SprintId.parse(opts.sprint);
      if (!sprintId.ok) {
        process.stderr.write(`error: invalid sprint id: ${sprintId.error.message}\n`);
        process.exit(1);
        return;
      }
      const { deps } = await bootstrapCli();
      const result = await deps.taskRepo.findBySprintId(sprintId.value);
      if (!result.ok) {
        process.stderr.write(`error: ${result.error.message}\n`);
        process.exit(1);
        return;
      }
      if (result.value.length === 0) {
        process.stdout.write('(no tasks yet — run plan to generate them)\n');
        return;
      }
      for (const t of result.value) {
        process.stdout.write(`${formatTaskLine(t)}\n`);
      }
    });

  task
    .command('show <taskId>')
    .description('print a single task as JSON')
    .requiredOption('-s, --sprint <id>', 'sprint id')
    .action(async (rawTaskId: string, opts: SprintOpt) => {
      const sprintId = SprintId.parse(opts.sprint);
      if (!sprintId.ok) {
        process.stderr.write(`error: invalid sprint id: ${sprintId.error.message}\n`);
        process.exit(1);
        return;
      }
      const taskId = TaskId.parse(rawTaskId);
      if (!taskId.ok) {
        process.stderr.write(`error: invalid task id: ${taskId.error.message}\n`);
        process.exit(1);
        return;
      }
      const { deps } = await bootstrapCli();
      const result = await deps.taskRepo.findById(sprintId.value, taskId.value);
      if (!result.ok) {
        process.stderr.write(`error: ${result.error.message}\n`);
        process.exit(1);
        return;
      }
      process.stdout.write(`${JSON.stringify(result.value, null, 2)}\n`);
    });
};

const formatTaskLine = (t: Task): string => {
  const orderStr = String(t.order).padStart(3, ' ');
  return `${orderStr}.  ${String(t.id)}  [${t.status.padEnd(8)}]  ${t.name}`;
};
