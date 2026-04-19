import type { Command } from 'commander';
import { taskAddCommand } from '@src/integration/cli/commands/task/add.ts';
import { taskListCommand } from '@src/integration/cli/commands/task/list.ts';
import { taskShowCommand } from '@src/integration/cli/commands/task/show.ts';
import { taskRemoveCommand } from '@src/integration/cli/commands/task/remove.ts';
import { taskStatusCommand } from '@src/integration/cli/commands/task/status.ts';
import { taskNextCommand } from '@src/integration/cli/commands/task/next.ts';
import { taskReorderCommand } from '@src/integration/cli/commands/task/reorder.ts';
import { taskImportCommand } from '@src/integration/cli/commands/task/import.ts';
import { taskWhyCommand } from '@src/integration/cli/commands/task/why.ts';

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
    .option('-d, --description <desc>', 'Description')
    .option('--step <step...>', 'Implementation step (repeatable)')
    .option('--ticket <id>', 'Link to ticket ID')
    .option('-r, --repo <name-or-id>', "Repository (within the sprint's project)")
    .option('-n, --no-interactive', 'Non-interactive mode (error on missing params)')
    .action(
      async (opts: {
        name?: string;
        description?: string;
        step?: string[];
        ticket?: string;
        repo?: string;
        interactive?: boolean;
      }) => {
        await taskAddCommand({
          name: opts.name,
          description: opts.description,
          steps: opts.step,
          ticket: opts.ticket,
          repo: opts.repo,
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
    .option('--status <status>', 'Filter by status (todo, in_progress, done)')
    .option('--repo <name-or-id>', 'Filter by repo id')
    .option('--ticket <id>', 'Filter by ticket ID')
    .option('--blocked', 'Show only blocked tasks')
    .action(async (opts: { brief?: boolean; status?: string; repo?: string; ticket?: string; blocked?: boolean }) => {
      const args: string[] = [];
      if (opts.brief) args.push('-b');
      if (opts.status) args.push('--status', opts.status);
      if (opts.repo) args.push('--repo', opts.repo);
      if (opts.ticket) args.push('--ticket', opts.ticket);
      if (opts.blocked) args.push('--blocked');
      await taskListCommand(args);
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
    .option('-n, --no-interactive', 'Non-interactive mode (exit with error codes)')
    .action(async (id?: string, status?: string, opts?: { interactive?: boolean }) => {
      await taskStatusCommand([], {
        taskId: id,
        status,
        noInteractive: opts?.interactive === false,
      });
    });

  task.command('next').description('Get next task').action(taskNextCommand);

  task
    .command('why [id]')
    .description('Explain why a task is blocked (walks the dependency chain)')
    .action(async (id?: string) => {
      await taskWhyCommand(id);
    });

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
