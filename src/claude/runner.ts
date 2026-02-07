import { confirm } from '@inquirer/prompts';
import { info, muted, success, warning } from '@src/theme/index.ts';
import { activateSprint, assertSprintStatus, closeSprint, getSprint, resolveSprintId } from '@src/store/sprint.ts';
import { areAllTasksDone, DependencyCycleError, getRemainingTasks, reorderByDependencies } from '@src/store/task.ts';
import {
  executeTaskLoop,
  executeTaskLoopParallel,
  type ExecutionSummary,
  type ExecutorOptions,
} from '@src/claude/executor.ts';

// Re-export types for convenience
export type { ExecutorOptions, ExecutionSummary } from '@src/claude/executor.ts';

// Alias for backward compatibility
export type RunnerOptions = ExecutorOptions;

/**
 * Determine if execution should use parallel mode.
 * Forces sequential for session mode, step mode, or explicit --concurrency 1.
 */
function shouldRunParallel(options: ExecutorOptions): boolean {
  if (options.session) return false;
  if (options.step) return false;
  if (options.concurrency === 1) return false;
  return true;
}

/**
 * Run sprint execution with lifecycle management.
 * Handles sprint activation, dependency reordering, execution, and closing.
 */
export async function runSprint(
  sprintId: string | undefined,
  options: ExecutorOptions
): Promise<ExecutionSummary | undefined> {
  const id = await resolveSprintId(sprintId);
  let sprint = await getSprint(id);

  // Auto-activate if sprint is draft
  if (sprint.status === 'draft') {
    sprint = await activateSprint(id);
  }

  // Validate sprint is active
  assertSprintStatus(sprint, ['active'], 'start');

  console.log(info('\n=== Sprint Start ==='));
  console.log(info('Sprint: ') + sprint.name);
  console.log(info('ID:     ') + sprint.id);

  const modes: string[] = [];
  if (options.session) {
    modes.push('session');
  } else {
    modes.push('headless');
  }
  if (options.step) {
    modes.push('step-by-step');
  }
  if (options.noCommit) {
    modes.push('no-commit');
  }

  const parallel = shouldRunParallel(options);
  if (parallel) {
    modes.push('parallel');
  }
  console.log(muted(`Mode: ${modes.join(', ')}`));
  if (options.count) {
    console.log(muted(`Limit: ${String(options.count)} task(s)`));
  }

  // Reorder tasks by dependencies
  try {
    await reorderByDependencies(id);
    console.log(muted('Tasks reordered by dependencies'));
  } catch (err) {
    if (err instanceof DependencyCycleError) {
      console.log(warning(`\n${err.message}`));
      console.log(muted('Fix the dependency cycle before starting.\n'));
      return undefined;
    }
    throw err;
  }

  // Execute the task loop (parallel or sequential)
  const summary = parallel ? await executeTaskLoopParallel(id, options) : await executeTaskLoop(id, options);

  // Print summary
  console.log(info('\n=== Summary ==='));
  console.log(info('Completed: ') + String(summary.completed) + ' task(s)');
  console.log(info('Remaining: ') + String(summary.remaining) + ' task(s)');

  // Handle sprint closing for fully completed sprints
  if (await areAllTasksDone(id)) {
    console.log(success('\nAll tasks in sprint are done!'));
    const shouldClose = await confirm({
      message: 'Close the sprint?',
      default: true,
    });
    if (shouldClose) {
      await closeSprint(id);
      console.log(success(`Sprint closed: ${id}`));
    }
  } else if (summary.stopReason === 'all_blocked') {
    console.log(warning('\nAll remaining tasks are blocked by dependencies.'));
    const remaining = await getRemainingTasks(id);
    const blockedTasks = remaining.filter((t) => t.blockedBy.length > 0);
    if (blockedTasks.length > 0) {
      console.log(muted('Blocked tasks:'));
      for (const t of blockedTasks.slice(0, 5)) {
        console.log(muted(`  - ${t.name} (blocked by: ${t.blockedBy.join(', ')})`));
      }
      if (blockedTasks.length > 5) {
        console.log(muted(`  ... and ${String(blockedTasks.length - 5)} more`));
      }
    }
  }

  console.log('');

  return summary;
}
