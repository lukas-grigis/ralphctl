import { info, muted, error } from '@src/utils/colors.ts';
import { taskAddCommand } from '@src/commands/task/add.ts';
import { taskListCommand } from '@src/commands/task/list.ts';
import { taskShowCommand } from '@src/commands/task/show.ts';
import { taskRemoveCommand } from '@src/commands/task/remove.ts';
import { taskStatusCommand } from '@src/commands/task/status.ts';
import { taskNextCommand } from '@src/commands/task/next.ts';
import { taskReorderCommand } from '@src/commands/task/reorder.ts';
import { taskImportCommand } from '@src/commands/task/import.ts';

function showTaskUsage(): void {
  console.log(info('\nUsage: ralphctl task <command> [options]\n'));
  console.log(info('Commands:'));
  console.log('  add                           Add task interactively');
  console.log('  import <file.json>            Import tasks from JSON file');
  console.log('  list                          List tasks in active scope');
  console.log('  show <id>                     Show task details');
  console.log('  remove <id>                   Remove task from scope');
  console.log('  status <id> <status>          Update task status');
  console.log('  next                          Get next task (by order, status=todo)');
  console.log('  reorder <id> <new-order>      Change task priority');
  console.log(info('\nStatuses:'));
  console.log('  todo, in_progress, testing, done');
  console.log(muted('\nExamples:'));
  console.log(muted('  $ ralphctl task add'));
  console.log(muted('  $ ralphctl task import tasks.json'));
  console.log(muted('  $ ralphctl task status task-001 in_progress\n'));
}

export async function taskCommand(args: string[]): Promise<void> {
  const subcommand = args[0];
  const subArgs = args.slice(1);

  switch (subcommand) {
    case 'add':
      await taskAddCommand();
      break;
    case 'import':
      await taskImportCommand(subArgs);
      break;
    case 'list':
      await taskListCommand();
      break;
    case 'show':
      await taskShowCommand(subArgs);
      break;
    case 'remove':
      await taskRemoveCommand(subArgs);
      break;
    case 'status':
      await taskStatusCommand(subArgs);
      break;
    case 'next':
      await taskNextCommand();
      break;
    case 'reorder':
      await taskReorderCommand(subArgs);
      break;
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      showTaskUsage();
      break;
    default:
      console.log(error(`Unknown task command: ${subcommand}\n`));
      showTaskUsage();
      process.exit(1);
  }
}
