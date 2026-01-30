import { confirm } from '@inquirer/prompts';
import { success, info, muted, error, warning } from '@src/utils/colors.ts';
import {
  closeScope,
  resolveScopeId,
  ScopeStatusError,
  ScopeNotFoundError,
} from '@src/services/scope.ts';
import { areAllTasksDone, listTasks } from '@src/services/task.ts';

export async function scopeCloseCommand(args: string[]): Promise<void> {
  let scopeId: string;
  try {
    scopeId = await resolveScopeId(args[0]);
  } catch {
    console.log(warning('\nNo scope specified and no active scope set.'));
    console.log(muted('Specify a scope ID or activate one first.\n'));
    return;
  }

  // Check if all tasks are done
  const allDone = await areAllTasksDone(scopeId);
  if (!allDone) {
    const tasks = await listTasks(scopeId);
    const remaining = tasks.filter((t) => t.status !== 'done');
    console.log(warning(`\nWarning: ${String(remaining.length)} task(s) are not done:`));
    for (const task of remaining) {
      console.log(`  - ${task.id}: ${task.name} (${task.status})`);
    }
    console.log('');

    const proceed = await confirm({
      message: 'Close scope anyway?',
      default: false,
    });

    if (!proceed) {
      console.log(muted('\nScope close cancelled.\n'));
      return;
    }
  }

  try {
    const scope = await closeScope(scopeId);
    console.log(success('\nScope closed successfully!'));
    console.log(info('  ID:     ') + scope.id);
    console.log(info('  Name:   ') + scope.name);
    console.log(info('  Status: ') + scope.status);
    console.log(muted('\nThe scope has been archived.\n'));
  } catch (err) {
    if (err instanceof ScopeNotFoundError) {
      console.log(error(`\nScope not found: ${scopeId}\n`));
    } else if (err instanceof ScopeStatusError) {
      console.log(error(`\n${err.message}\n`));
    } else {
      throw err;
    }
  }
}
