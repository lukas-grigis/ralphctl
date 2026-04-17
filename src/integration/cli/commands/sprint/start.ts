import { areAllTasksDone, getRemainingTasks } from '@src/integration/persistence/task.ts';
import { closeSprint } from '@src/integration/persistence/sprint.ts';
import { EXIT_ERROR, EXIT_NO_TASKS, exitWithCode } from '@src/domain/exit-codes.ts';
import {
  log,
  printHeader,
  showError,
  showNextStep,
  showRandomQuote,
  showSuccess,
  showWarning,
  terminalBell,
} from '@src/integration/ui/theme/ui.ts';
import { getPrompt, getSharedDeps } from '@src/integration/bootstrap.ts';
import { createExecuteSprintPipeline } from '@src/application/factories.ts';
import { executePipeline } from '@src/business/pipelines/framework/pipeline.ts';
import type { ExecutionOptions } from '@src/domain/context.ts';

/**
 * Pure arg parser exposed for the Ink dispatch in `src/cli.ts`. Returns a
 * Result-shaped value so the caller decides how to surface errors.
 */
export function parseSprintStartArgs(
  args: string[]
): { ok: true; value: { sprintId?: string; options: ExecutionOptions } } | { ok: false; error: string } {
  try {
    return { ok: true, value: parseArgs(args) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function parseArgs(args: string[]): { sprintId?: string; options: ExecutionOptions } {
  const options: ExecutionOptions = {};
  let sprintId: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '-t' || arg === '--step') {
      options.step = true;
    } else if (arg === '-s' || arg === '--session') {
      options.session = true;
    } else if (arg === '--no-commit') {
      options.noCommit = true;
    } else if (arg === '-c' || arg === '--count') {
      const countStr = args[++i];
      if (!countStr) throw new Error('--count requires a number');
      const count = parseInt(countStr, 10);
      if (isNaN(count) || count < 1 || count > 10000) throw new Error('--count must be an integer between 1 and 10000');
      options.count = count;
    } else if (arg === '--concurrency') {
      const concStr = args[++i];
      if (!concStr) throw new Error('--concurrency requires a number');
      const conc = parseInt(concStr, 10);
      if (isNaN(conc) || conc < 1 || conc > 10) throw new Error('--concurrency must be an integer between 1 and 10');
      options.concurrency = conc;
    } else if (arg === '--max-retries') {
      const retryStr = args[++i];
      if (!retryStr) throw new Error('--max-retries requires a number');
      const retries = parseInt(retryStr, 10);
      if (isNaN(retries) || retries < 0 || retries > 20)
        throw new Error('--max-retries must be an integer between 0 and 20');
      options.maxRetries = retries;
    } else if (arg === '--fail-fast') {
      options.failFast = true;
    } else if (arg === '--no-fail-fast') {
      options.failFast = false;
    } else if (arg === '-f' || arg === '--force') {
      options.force = true;
    } else if (arg === '--refresh-check') {
      options.refreshCheck = true;
    } else if (arg === '-b' || arg === '--branch') {
      options.branch = true;
    } else if (arg === '--branch-name') {
      const nameStr = args[++i];
      if (!nameStr) throw new Error('--branch-name requires a value');
      options.branchName = nameStr;
    } else if (arg === '--max-budget-usd') {
      const budgetStr = args[++i];
      if (!budgetStr) throw new Error('--max-budget-usd requires a number');
      const budget = parseFloat(budgetStr);
      if (isNaN(budget) || budget <= 0) throw new Error('--max-budget-usd must be a positive number');
      options.maxBudgetUsd = budget;
    } else if (arg === '--fallback-model') {
      const modelStr = args[++i];
      if (!modelStr) throw new Error('--fallback-model requires a model name');
      if (!/^[a-zA-Z0-9._-]{1,100}$/.test(modelStr))
        throw new Error('Invalid model name — must be 1-100 alphanumeric characters, dots, hyphens, or underscores');
      options.fallbackModel = modelStr;
    } else if (arg === '--max-turns') {
      const turnsStr = args[++i];
      if (!turnsStr) throw new Error('--max-turns requires a number');
      const turns = parseInt(turnsStr, 10);
      if (isNaN(turns) || turns <= 0) throw new Error('--max-turns must be a positive integer');
      options.maxTurns = turns;
    } else if (arg === '--no-evaluate') {
      options.noEvaluate = true;
    } else if (arg === '--no-feedback') {
      options.noFeedback = true;
    } else if (!arg?.startsWith('-')) {
      sprintId = arg;
    }
  }

  return { sprintId, options };
}

export async function sprintStartCommand(args: string[]): Promise<void> {
  let sprintId: string | undefined;
  let options: ExecutionOptions;

  try {
    const parsed = parseArgs(args);
    sprintId = parsed.sprintId;
    options = parsed.options;
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
    log.newline();
    exitWithCode(EXIT_ERROR);
    return;
  }

  const shared = getSharedDeps();

  let id: string;
  try {
    id = await shared.persistence.resolveSprintId(sprintId);
  } catch {
    showWarning('No sprint specified and no active sprint set.');
    showNextStep('ralphctl sprint start <id>', 'specify a sprint ID');
    log.newline();
    exitWithCode(EXIT_NO_TASKS);
    return;
  }

  const pipeline = createExecuteSprintPipeline(shared, options);
  const result = await executePipeline(pipeline, { sprintId: id });

  if (!result.ok) {
    showError(result.error.message);
    log.newline();
    exitWithCode(EXIT_ERROR);
    return;
  }

  const summary = result.value.context.executionSummary;
  if (!summary) {
    // Pipeline completed but no summary was written — should be unreachable
    // (prepare-tasks / execute-tasks / check-preconditions all write one).
    showError('Execution completed without a summary. This is a bug.');
    log.newline();
    exitWithCode(EXIT_ERROR);
    return;
  }

  // Print summary
  printHeader('Summary');
  log.info(`Completed: ${String(summary.completed)} task(s)`);
  log.info(`Remaining: ${String(summary.remaining)} task(s)`);

  // Handle sprint closing for fully completed sprints
  if (summary.stopReason === 'all_completed' && summary.remaining === 0 && summary.completed > 0) {
    if (await areAllTasksDone(id)) {
      terminalBell();
      showSuccess('All tasks in sprint are done!');
      showRandomQuote();
      const shouldClose = await getPrompt().confirm({
        message: 'Close the sprint?',
        default: true,
      });
      if (shouldClose) {
        await closeSprint(id);
        showSuccess(`Sprint closed: ${id}`);
      }
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
  exitWithCode(summary.exitCode);
}
