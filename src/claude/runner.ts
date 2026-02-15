import { confirm } from '@inquirer/prompts';
import { log, printHeader, showRandomQuote, showSuccess, showWarning, terminalBell } from '@src/theme/ui.ts';
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

  printHeader('Sprint Start');
  log.info(`Sprint: ${sprint.name}`);
  log.info(`ID:     ${sprint.id}`);

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
  log.dim(`Mode: ${modes.join(', ')}`);
  if (options.count) {
    log.dim(`Limit: ${String(options.count)} task(s)`);
  }

  // Reorder tasks by dependencies
  try {
    await reorderByDependencies(id);
    log.dim('Tasks reordered by dependencies');
  } catch (err) {
    if (err instanceof DependencyCycleError) {
      log.newline();
      showWarning(err.message);
      log.dim('Fix the dependency cycle before starting.');
      log.newline();
      return undefined;
    }
    throw err;
  }

  // Execute the task loop (parallel or sequential)
  const summary = parallel ? await executeTaskLoopParallel(id, options) : await executeTaskLoop(id, options);

  // Print summary
  printHeader('Summary');
  log.info(`Completed: ${String(summary.completed)} task(s)`);
  log.info(`Remaining: ${String(summary.remaining)} task(s)`);

  // Handle sprint closing for fully completed sprints
  if (await areAllTasksDone(id)) {
    terminalBell();
    showSuccess('All tasks in sprint are done!');
    showRandomQuote();
    const shouldClose = await confirm({
      message: 'Close the sprint?',
      default: true,
    });
    if (shouldClose) {
      await closeSprint(id);
      showSuccess(`Sprint closed: ${id}`);
    }
  } else if (summary.stopReason === 'all_blocked') {
    log.newline();
    showWarning('All remaining tasks are blocked by dependencies.');
    const remaining = await getRemainingTasks(id);
    const blockedTasks = remaining.filter((t) => t.blockedBy.length > 0);
    if (blockedTasks.length > 0) {
      log.dim('Blocked tasks:');
      for (const t of blockedTasks.slice(0, 5)) {
        log.item(`${t.name} (blocked by: ${t.blockedBy.join(', ')})`);
      }
      if (blockedTasks.length > 5) {
        log.dim(`  ... and ${String(blockedTasks.length - 5)} more`);
      }
    }
  }

  log.newline();

  return summary;
}
