import type { Command } from 'commander';
import { taskAddCommand } from '@src/commands/task/add.ts';
import { taskListCommand } from '@src/commands/task/list.ts';
import { taskShowCommand } from '@src/commands/task/show.ts';
import { taskRemoveCommand } from '@src/commands/task/remove.ts';
import { taskStatusCommand } from '@src/commands/task/status.ts';
import { taskNextCommand } from '@src/commands/task/next.ts';
import { taskReorderCommand } from '@src/commands/task/reorder.ts';
import { taskImportCommand } from '@src/commands/task/import.ts';

export function registerTaskCommands(program: Command): void {
  const task = program.command('task').description('Manage tasks');

  task.addHelpText(
    'after',
    `
Examples:
  $ ralphctl task add --name "Implement login" --ticket abc123
  $ ralphctl task list
  $ ralphctl task status abc123 done
  $ ralphctl task next
`
  );

  task
    .command('add')
    .description('Add task to current sprint')
    .option('--name <name>', 'Task name')
    .option('--description <desc>', 'Description')
    .option('--step <step...>', 'Implementation step (repeatable)')
    .option('--ticket <id>', 'Link to ticket ID')
    .option('--project <path>', 'Project path')
    .option('-n, --no-interactive', 'Non-interactive mode (error on missing params)')
    .action(
      async (opts: {
        name?: string;
        description?: string;
        step?: string[];
        ticket?: string;
        project?: string;
        interactive?: boolean;
      }) => {
        await taskAddCommand({
          name: opts.name,
          description: opts.description,
          steps: opts.step,
          ticket: opts.ticket,
          project: opts.project,
          // --no-interactive sets interactive=false, otherwise true (prompt for missing)
          interactive: opts.interactive !== false,
        });
      }
    );

  task
    .command('import <file>')
    .description('Import tasks from JSON file')
    .action(async (file: string) => {
      await taskImportCommand([file]);
    });

  task
    .command('list')
    .description('List tasks')
    .option('-b, --brief', 'Brief format')
    .action(async (opts: { brief?: boolean }) => {
      await taskListCommand(opts.brief ? ['-b'] : []);
    });

  task
    .command('show [id]')
    .description('Show task details')
    .action(async (id?: string) => {
      await taskShowCommand(id ? [id] : []);
    });

  task
    .command('remove [id]')
    .description('Remove a task')
    .option('-y, --yes', 'Skip confirmation')
    .action(async (id?: string, opts?: { yes?: boolean }) => {
      const args: string[] = [];
      if (id) args.push(id);
      if (opts?.yes) args.push('-y');
      await taskRemoveCommand(args);
    });

  task
    .command('status [id] [status]')
    .description('Update task status (todo/in_progress/done)')
    .option('-n, --non-interactive', 'Non-interactive mode (exit with error codes)')
    .action(async (id?: string, status?: string, opts?: { nonInteractive?: boolean }) => {
      await taskStatusCommand([], {
        taskId: id,
        status,
        nonInteractive: opts?.nonInteractive,
      });
    });

  task.command('next').description('Get next task').action(taskNextCommand);

  task
    .command('reorder [id] [position]')
    .description('Change task priority')
    .action(async (id?: string, position?: string) => {
      const args: string[] = [];
      if (id) args.push(id);
      if (position) args.push(position);
      await taskReorderCommand(args);
    });
}
