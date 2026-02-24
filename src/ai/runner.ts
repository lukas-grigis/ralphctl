import { spawnSync } from 'node:child_process';
import { confirm, input, select } from '@inquirer/prompts';
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
  getEffectiveSetupScript,
  getProjectForTask,
  type SetupResults,
  type SetupStatus,
} from '@src/ai/task-context.ts';
import type { Sprint } from '@src/schemas/index.ts';
import { assertSafeCwd } from '@src/utils/paths.ts';
import {
  createAndCheckoutBranch,
  generateBranchName,
  getCurrentBranch,
  hasUncommittedChanges,
  isValidBranchName,
  verifyCurrentBranch,
} from '@src/utils/git.ts';

// Re-export types for convenience
export type { ExecutorOptions, ExecutionSummary } from '@src/ai/executor.ts';

// Alias for backward compatibility
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
    try {
      if (hasUncommittedChanges(projectPath)) {
        throw new Error(
          `Repository at ${projectPath} has uncommitted changes. ` + 'Commit or stash them before starting the sprint.'
        );
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('uncommitted changes')) {
        throw err;
      }
      // Not a git repo or other git error — skip with notice
      log.dim(`  Skipping ${projectPath} — not a git repository`);
      continue;
    }
  }

  // Create/checkout branch in each repo
  for (const projectPath of uniquePaths) {
    try {
      const currentBranch = getCurrentBranch(projectPath);
      if (currentBranch === branchName) {
        log.dim(`  Already on branch '${branchName}' in ${projectPath}`);
      } else {
        createAndCheckoutBranch(projectPath, branchName);
        log.success(`  Branch '${branchName}' ready in ${projectPath}`);
      }
    } catch (err) {
      throw new Error(
        `Failed to create branch '${branchName}' in ${projectPath}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err }
      );
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
  try {
    if (verifyCurrentBranch(projectPath, expectedBranch)) {
      return true;
    }

    // Attempt auto-recovery
    log.dim(`  Branch mismatch in ${projectPath} — checking out '${expectedBranch}'`);
    createAndCheckoutBranch(projectPath, expectedBranch);
    return verifyCurrentBranch(projectPath, expectedBranch);
  } catch {
    return false;
  }
}

// ============================================================================
// SETUP SCRIPT EXECUTION
// ============================================================================

/** Default timeout for setup scripts: 5 minutes. Override via RALPHCTL_SETUP_TIMEOUT_MS. */
const DEFAULT_SETUP_TIMEOUT_MS = 5 * 60 * 1000;

function getSetupTimeoutMs(): number {
  const envVal = process.env['RALPHCTL_SETUP_TIMEOUT_MS'];
  if (envVal) {
    const parsed = Number(envVal);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_SETUP_TIMEOUT_MS;
}

/**
 * Run setupScript for every unique projectPath that has remaining tasks.
 *
 * This is "stage zero" — the environment must be ready before any AI agent
 * starts work (aligned with the Anthropic effective-harnesses article).
 *
 * Design notes:
 * - Setup tracking: timestamps recorded in sprint.setupRanAt so re-runs skip
 *   already-completed setups (idempotent resume). Use refreshSetup to force.
 * - Fail-fast on multi-repo — partial setup is worse than no setup, so we abort
 *   on first failure rather than continuing with an inconsistent environment
 * - Repos without a configured setup script are skipped with a dim warning
 * - Returns a SetupResults map so the executor can inform each AI agent what ran
 *
 * @returns { success, results } — results maps projectPath → SetupStatus
 */
export async function runSetupScripts(
  sprintId: string,
  sprint: Sprint,
  refreshSetup = false
): Promise<{ success: true; results: SetupResults } | { success: false; error: string }> {
  const results: SetupResults = new Map();
  const tasks = await getTasks(sprintId);
  const remainingTasks = tasks.filter((t) => t.status !== 'done');

  // Collect unique project paths from remaining tasks
  const uniquePaths = [...new Set(remainingTasks.map((t) => t.projectPath))];

  if (uniquePaths.length === 0) {
    return { success: true, results };
  }

  const timeoutMs = getSetupTimeoutMs();

  for (const projectPath of uniquePaths) {
    // Find a representative task for this path so we can look up its project
    const taskForPath = remainingTasks.find((t) => t.projectPath === projectPath);
    if (!taskForPath) continue;

    const project = await getProjectForTask(taskForPath, sprint);

    // Setup scripts come from explicit repo config only — no runtime auto-detection.
    // Heuristic detection is used as suggestions during `project add` / `project repo add`.
    const setupScript = getEffectiveSetupScript(project, projectPath);
    const repo = project?.repositories.find((r) => r.path === projectPath);
    const repoName = repo?.name ?? projectPath;

    if (!setupScript) {
      log.dim(`  No setup script for ${repoName} — configure via 'project add'`);
      results.set(projectPath, { ran: false, reason: 'no-script' } satisfies SetupStatus);
      continue;
    }

    // Check if setup already ran this sprint (skip unless --refresh-setup)
    const previousRun = sprint.setupRanAt[projectPath];
    if (previousRun && !refreshSetup) {
      log.dim(`  Setup already ran for ${repoName} at ${previousRun} — skipping`);
      results.set(projectPath, { ran: true, script: setupScript } satisfies SetupStatus);
      continue;
    }

    log.info(`\nRunning setup for ${repoName}: ${setupScript}`);

    // Trust boundary: setupScripts are user-configured via `project add` or
    // `project repo add` — they are NOT arbitrary AI-generated commands.
    assertSafeCwd(projectPath);
    const result = spawnSync(setupScript, {
      cwd: projectPath,
      shell: true,
      stdio: 'inherit',
      encoding: 'utf-8',
      timeout: timeoutMs,
    });

    if (result.signal === 'SIGTERM') {
      return {
        success: false,
        error:
          `Setup timed out for ${repoName} after ${String(timeoutMs / 1000)}s: ${setupScript}\n` +
          `  Set RALPHCTL_SETUP_TIMEOUT_MS to increase the timeout (current: ${String(timeoutMs)}ms)`,
      };
    }

    if (result.status !== 0) {
      return {
        success: false,
        error: `Setup failed for ${repoName} (exit ${String(result.status ?? 1)}): ${setupScript}`,
      };
    }

    // Record timestamp per-repo (persisted immediately so partial failures are safe)
    sprint.setupRanAt[projectPath] = new Date().toISOString();
    await saveSprint(sprint);

    log.success(`Setup complete: ${repoName}`);
    results.set(projectPath, { ran: true, script: setupScript } satisfies SetupStatus);
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
    try {
      await ensureSprintBranches(id, sprint, branchName);
    } catch (err) {
      log.newline();
      showError(err instanceof Error ? err.message : String(err));
      log.newline();
      return undefined;
    }
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

  // Stage zero: run setup scripts for all repositories
  const setupResult = await runSetupScripts(id, sprint, options.refreshSetup);
  if (!setupResult.success) {
    log.newline();
    showError(setupResult.error);
    log.newline();
    return undefined;
  }

  // Execute the task loop (parallel or sequential)
  const summary = parallel
    ? await executeTaskLoopParallel(id, options, setupResult.results)
    : await executeTaskLoop(id, options, setupResult.results);

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
