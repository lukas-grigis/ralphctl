import { confirm, input, select } from '@inquirer/prompts';
import { Result } from 'typescript-result';
import { ensureError, wrapAsync } from '@src/utils/result-helpers.ts';
import { log, printHeader, showError, showRandomQuote, showSuccess, showWarning, terminalBell } from '@src/theme/ui.ts';
import {
  activateSprint,
  assertSprintStatus,
  closeSprint,
  getSprint,
  resolveSprintId,
  saveSprint,
} from '@src/store/sprint.ts';
import {
  areAllTasksDone,
  DependencyCycleError,
  getRemainingTasks,
  getTasks,
  reorderByDependencies,
} from '@src/store/task.ts';
import { formatTicketId, getPendingRequirements } from '@src/store/ticket.ts';
import {
  executeTaskLoop,
  executeTaskLoopParallel,
  type ExecutionSummary,
  type ExecutorOptions,
} from '@src/ai/executor.ts';
import {
  getEffectiveCheckScript,
  getProjectForTask,
  type CheckResults,
  type CheckStatus,
} from '@src/ai/task-context.ts';
import { runLifecycleHook } from '@src/ai/lifecycle.ts';
import type { Sprint } from '@src/schemas/index.ts';
import {
  createAndCheckoutBranch,
  generateBranchName,
  getCurrentBranch,
  hasUncommittedChanges,
  isValidBranchName,
  verifyCurrentBranch,
} from '@src/utils/git.ts';

export type { ExecutorOptions, ExecutionSummary } from '@src/ai/executor.ts';
export type RunnerOptions = ExecutorOptions;

// ============================================================================
// BRANCH MANAGEMENT
// ============================================================================

/**
 * Prompt the user to select a branch strategy for sprint execution.
 * Returns the branch name to use, or null for no branch management.
 */
export async function promptBranchStrategy(sprintId: string): Promise<string | null> {
  const autoBranch = generateBranchName(sprintId);

  const strategy = await select({
    message: 'How should this sprint manage branches?',
    choices: [
      {
        name: `Create sprint branch: ${autoBranch} (Recommended)`,
        value: 'auto',
      },
      {
        name: 'Keep current branch (no branch management)',
        value: 'keep',
      },
      {
        name: 'Custom branch name',
        value: 'custom',
      },
    ],
  });

  if (strategy === 'keep') return null;
  if (strategy === 'auto') return autoBranch;

  // Custom branch name
  const customName = await input({
    message: 'Enter branch name:',
    validate: (value) => {
      if (!value.trim()) return 'Branch name cannot be empty';
      if (!isValidBranchName(value.trim())) {
        return 'Invalid branch name. Use alphanumeric characters, hyphens, underscores, dots, and slashes.';
      }
      return true;
    },
  });

  return customName.trim();
}

/**
 * Resolve the branch to use for sprint execution.
 *
 * Priority:
 * 1. options.branchName — explicit CLI override
 * 2. options.branch — auto-generate from sprint ID
 * 3. sprint.branch — saved from previous run (resume)
 * 4. Interactive prompt — first run without flags
 *
 * Returns the branch name or null (no branch management).
 */
export async function resolveBranch(
  sprintId: string,
  sprint: Sprint,
  options: ExecutorOptions
): Promise<string | null> {
  if (options.branchName) return options.branchName;
  if (options.branch) return generateBranchName(sprintId);
  if (sprint.branch) return sprint.branch;
  return promptBranchStrategy(sprintId);
}

/**
 * Create/checkout the sprint branch in every repo that has remaining tasks.
 *
 * - Collects unique projectPath values from remaining tasks
 * - Fails fast if any repo has uncommitted changes
 * - Creates or checks out the branch (idempotent for resume)
 * - Persists sprint.branch for subsequent runs
 */
export async function ensureSprintBranches(sprintId: string, sprint: Sprint, branchName: string): Promise<void> {
  if (!isValidBranchName(branchName)) {
    throw new Error(`Invalid branch name: ${branchName}`);
  }

  const tasks = await getTasks(sprintId);
  const remainingTasks = tasks.filter((t) => t.status !== 'done');
  const uniquePaths = [...new Set(remainingTasks.map((t) => t.projectPath))];

  if (uniquePaths.length === 0) return;

  // Check for uncommitted changes in all repos first (fail-fast)
  for (const projectPath of uniquePaths) {
    const uncommittedR = Result.try(() => hasUncommittedChanges(projectPath));
    if (!uncommittedR.ok) {
      // hasUncommittedChanges threw — not a git repo or other git error
      log.dim(`  Skipping ${projectPath} — not a git repository`);
      continue;
    }
    if (uncommittedR.value) {
      throw new Error(
        `Repository at ${projectPath} has uncommitted changes. ` + 'Commit or stash them before starting the sprint.'
      );
    }
  }

  // Create/checkout branch in each repo
  for (const projectPath of uniquePaths) {
    const branchR = Result.try(() => {
      const currentBranch = getCurrentBranch(projectPath);
      if (currentBranch === branchName) {
        log.dim(`  Already on branch '${branchName}' in ${projectPath}`);
      } else {
        createAndCheckoutBranch(projectPath, branchName);
        log.success(`  Branch '${branchName}' ready in ${projectPath}`);
      }
    });
    if (!branchR.ok) {
      throw new Error(`Failed to create branch '${branchName}' in ${projectPath}: ${branchR.error.message}`, {
        cause: branchR.error,
      });
    }
  }

  // Persist the branch name
  if (sprint.branch !== branchName) {
    sprint.branch = branchName;
    await saveSprint(sprint);
  }
}

/**
 * Verify a repo is on the expected sprint branch before task execution.
 * Attempts auto-recovery via checkout if on wrong branch.
 *
 * @returns true if on correct branch, false if recovery failed
 */
export function verifySprintBranch(projectPath: string, expectedBranch: string): boolean {
  const r = Result.try(() => {
    if (verifyCurrentBranch(projectPath, expectedBranch)) return true;
    // Attempt auto-recovery
    log.dim(`  Branch mismatch in ${projectPath} — checking out '${expectedBranch}'`);
    createAndCheckoutBranch(projectPath, expectedBranch);
    return verifyCurrentBranch(projectPath, expectedBranch);
  });
  return r.ok ? r.value : false;
}

// ============================================================================
// CHECK SCRIPT EXECUTION
// ============================================================================

/**
 * Run checkScript for every unique projectPath that has remaining tasks.
 *
 * This is "stage zero" — the environment must be ready before any AI agent
 * starts work (aligned with the Anthropic effective-harnesses article).
 *
 * Design notes:
 * - Check tracking: timestamps recorded in sprint.checkRanAt so re-runs skip
 *   already-completed checks (idempotent resume). Use refreshCheck to force.
 * - Fail-fast on multi-repo — partial setup is worse than no setup, so we abort
 *   on first failure rather than continuing with an inconsistent environment
 * - Repos without a configured check script are skipped with a dim warning
 * - Returns a CheckResults map so the executor can inform each AI agent what ran
 *
 * @returns { success, results } — results maps projectPath → CheckStatus
 */
export async function runCheckScripts(
  sprintId: string,
  sprint: Sprint,
  refreshCheck = false
): Promise<{ success: true; results: CheckResults } | { success: false; error: string }> {
  const results: CheckResults = new Map();
  const tasks = await getTasks(sprintId);
  const remainingTasks = tasks.filter((t) => t.status !== 'done');

  // Collect unique project paths from remaining tasks
  const uniquePaths = [...new Set(remainingTasks.map((t) => t.projectPath))];

  if (uniquePaths.length === 0) {
    return { success: true, results };
  }

  for (const projectPath of uniquePaths) {
    // Find a representative task for this path so we can look up its project
    const taskForPath = remainingTasks.find((t) => t.projectPath === projectPath);
    if (!taskForPath) continue;

    const project = await getProjectForTask(taskForPath, sprint);

    // Check scripts come from explicit repo config only — no runtime auto-detection.
    // Heuristic detection is used as suggestions during `project add` / `project repo add`.
    const checkScript = getEffectiveCheckScript(project, projectPath);
    const repo = project?.repositories.find((r) => r.path === projectPath);
    const repoName = repo?.name ?? projectPath;

    if (!checkScript) {
      log.dim(`  No check script for ${repoName} — configure via 'project add'`);
      results.set(projectPath, { ran: false, reason: 'no-script' } satisfies CheckStatus);
      continue;
    }

    // Check if already ran this sprint (skip unless --refresh-check)
    const previousRun = sprint.checkRanAt[projectPath];
    if (previousRun && !refreshCheck) {
      log.dim(`  Check already ran for ${repoName} at ${previousRun} — skipping`);
      results.set(projectPath, { ran: true, script: checkScript } satisfies CheckStatus);
      continue;
    }

    log.info(`\nRunning check for ${repoName}: ${checkScript}`);

    const hookResult = runLifecycleHook(projectPath, checkScript, 'sprintStart');

    if (!hookResult.passed) {
      return {
        success: false,
        error: `Check failed for ${repoName}: ${checkScript}\n${hookResult.output}`,
      };
    }

    // Record timestamp per-repo (persisted immediately so partial failures are safe)
    sprint.checkRanAt[projectPath] = new Date().toISOString();
    await saveSprint(sprint);

    log.success(`Check complete: ${repoName}`);
    results.set(projectPath, { ran: true, script: checkScript } satisfies CheckStatus);
  }

  return { success: true, results };
}

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

  // Precondition: warn if draft sprint has unrefined tickets
  if (sprint.status === 'draft' && !options.force) {
    const unrefinedTickets = getPendingRequirements(sprint.tickets);
    if (unrefinedTickets.length > 0) {
      showWarning(
        `Sprint has ${String(unrefinedTickets.length)} unrefined ticket${unrefinedTickets.length !== 1 ? 's' : ''}:`
      );
      for (const ticket of unrefinedTickets) {
        log.item(`${formatTicketId(ticket)} \u2014 ${ticket.title}`);
      }
      log.newline();

      const shouldContinue = await confirm({
        message: 'Start anyway without refining?',
        default: false,
      });
      if (!shouldContinue) {
        log.dim("Run 'sprint refine' first, or use --force to skip this check.");
        log.newline();
        return undefined;
      }
    }
  }

  // Precondition: block activation if draft sprint has approved tickets without tasks
  if (sprint.status === 'draft' && !options.force) {
    const tasks = await getTasks(id);
    const ticketIdsWithTasks = new Set(tasks.map((t) => t.ticketId).filter(Boolean));
    const unplannedTickets = sprint.tickets.filter(
      (t) => t.requirementStatus === 'approved' && !ticketIdsWithTasks.has(t.id)
    );

    if (unplannedTickets.length > 0) {
      showWarning('Sprint has refined tickets with no planned tasks:');
      for (const ticket of unplannedTickets) {
        log.item(`${formatTicketId(ticket)} \u2014 ${ticket.title}`);
      }
      log.newline();

      const shouldContinue = await confirm({
        message: 'Start anyway without planning?',
        default: false,
      });
      if (!shouldContinue) {
        log.dim("Run 'sprint plan' first, or use --force to skip this check.");
        log.newline();
        return undefined;
      }
    }
  }

  // Resolve branch strategy before activation (prompt while still interactable)
  const branchName = await resolveBranch(id, sprint, options);

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

  // Display branch info
  if (branchName) {
    log.info(`Branch: ${branchName}`);
  }

  // Ensure sprint branches are created/checked out in all repos
  if (branchName) {
    const ensureR = await wrapAsync(() => ensureSprintBranches(id, sprint, branchName), ensureError);
    if (!ensureR.ok) {
      log.newline();
      showError(ensureR.error.message);
      log.newline();
      return undefined;
    }
  }

  // Reorder tasks by dependencies
  const reorderR = await wrapAsync(() => reorderByDependencies(id), ensureError);
  if (!reorderR.ok) {
    if (reorderR.error instanceof DependencyCycleError) {
      log.newline();
      showWarning(reorderR.error.message);
      log.dim('Fix the dependency cycle before starting.');
      log.newline();
      return undefined;
    }
    throw reorderR.error;
  }
  log.dim('Tasks reordered by dependencies');

  // Stage zero: run check scripts for all repositories
  const checkResult = await runCheckScripts(id, sprint, options.refreshCheck);
  if (!checkResult.success) {
    log.newline();
    showError(checkResult.error);
    log.newline();
    return undefined;
  }

  // Execute the task loop (parallel or sequential)
  const summary = parallel
    ? await executeTaskLoopParallel(id, options, checkResult.results)
    : await executeTaskLoop(id, options, checkResult.results);

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
