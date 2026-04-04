import { confirm } from '@inquirer/prompts';
import { readFile, unlink } from 'node:fs/promises';
import { ensureError, wrapAsync } from '@src/utils/result-helpers.ts';
import { highlight, info, muted, success, warning } from '@src/theme/index.ts';
import { ProcessManager } from '@src/ai/process-manager.ts';
import {
  getNextTask,
  getReadyTasks,
  getRemainingTasks,
  getTasks,
  isTaskBlocked,
  updateTask,
  updateTaskStatus,
} from '@src/store/task.ts';
import { getProgress, logProgress, summarizeProgressForContext } from '@src/store/progress.ts';
import { getProgressFilePath, getSprintDir } from '@src/utils/paths.ts';
import { buildTaskExecutionPrompt } from '@src/ai/prompts/index.ts';
import type { Project, Task } from '@src/schemas/index.ts';
import { createSpinner, formatTaskStatus } from '@src/theme/ui.ts';
import { type ExecutionResult, parseExecutionResult } from '@src/ai/parser.ts';
import type { SpawnResult } from '@src/providers/types.ts';
import { type ProviderAdapter } from '@src/providers/types.ts';
import { spawnInteractive, spawnWithRetry } from '@src/ai/session.ts';
import { SpawnError } from '@src/errors.ts';
import { RateLimitCoordinator } from '@src/ai/rate-limiter.ts';
import { EXIT_ALL_BLOCKED, EXIT_ERROR, EXIT_NO_TASKS, EXIT_SUCCESS } from '@src/utils/exit-codes.ts';
import { getSprint } from '@src/store/sprint.ts';
import {
  buildFullTaskContext,
  type CheckResults,
  type CheckStatus,
  formatTask,
  getContextFileName,
  getEffectiveCheckScript,
  getProjectForTask,
  getRecentGitHistory,
  runPermissionCheck,
  type TaskContext,
  writeTaskContextFile,
} from '@src/ai/task-context.ts';
import { runLifecycleHook } from '@src/ai/lifecycle.ts';
import { getActiveProvider } from '@src/providers/index.ts';
import { verifySprintBranch } from '@src/ai/runner.ts';
import { getEvaluationIterations } from '@src/store/config.ts';
import { runEvaluation } from '@src/ai/evaluator.ts';

// ============================================================================
// TYPES
// ============================================================================

export interface ExecutorOptions {
  /** Step through tasks with approval between each */
  step: boolean;
  /** Limit number of tasks to execute */
  count: number | null;
  /** Interactive AI session (collaborate with provider) */
  session: boolean;
  /** Skip auto-commit after task completion */
  noCommit: boolean;
  /** Max parallel tasks (undefined = auto based on unique repos) */
  concurrency?: number;
  /** Max rate-limit retries per task */
  maxRetries?: number;
  /** Stop launching new tasks on first failure */
  failFast?: boolean;
  /** Skip precondition checks (e.g., unplanned tickets) */
  force?: boolean;
  /** Force re-run of check scripts even if they already ran this sprint */
  refreshCheck?: boolean;
  /** Auto-generate sprint branch (ralphctl/<sprint-id>) */
  branch?: boolean;
  /** Custom branch name for sprint execution */
  branchName?: string;
  /** Max USD budget per AI task (--max-budget-usd, Claude only) */
  maxBudgetUsd?: number;
  /** Fallback model when primary is overloaded (--fallback-model, Claude only) */
  fallbackModel?: string;
  /** Skip evaluation for this run (override global config) */
  noEvaluate?: boolean;
  /** Max agentic turns per task (--max-turns, Claude only). Prevents runaway loops. */
  maxTurns?: number;
}

/** Reason why execution stopped */
export type StopReason =
  | 'all_completed' // All tasks done
  | 'count_reached' // Reached task count limit
  | 'task_blocked' // A task could not be completed
  | 'user_paused' // User chose not to continue in interactive mode
  | 'no_tasks' // No tasks available
  | 'all_blocked'; // All remaining tasks blocked by dependencies

export interface ExecutionSummary {
  /** Number of tasks completed in this run */
  completed: number;
  /** Number of remaining tasks */
  remaining: number;
  /** Why execution stopped */
  stopReason: StopReason;
  /** Task that caused pause (if stopReason is task_blocked) */
  blockedTask: Task | null;
  /** Reason for block (if any) */
  blockedReason: string | null;
  /** Exit code for CLI */
  exitCode: number;
}

// ============================================================================
// TASK EXECUTION
// ============================================================================

/** Extended result that includes session ID for resume capability */
interface TaskExecutionResult extends ExecutionResult {
  sessionId: string | null;
  /** Model identifier from the AI provider (used for evaluator model ladder) */
  model: string | null;
}

/** Default max agentic turns per task — safety net against infinite loops in headless mode. */
const DEFAULT_MAX_TURNS = 200;

/** Build provider-specific CLI args from executor options (budget, fallback model, max turns). */
function buildProviderArgs(options: ExecutorOptions, provider: ProviderAdapter): string[] {
  if (provider.name !== 'claude') {
    // These flags are Claude-only — warn if the user passed them with another provider
    if (options.maxBudgetUsd != null) {
      console.log(warning(`--max-budget-usd is only supported with the Claude provider — ignored`));
    }
    if (options.fallbackModel) {
      console.log(warning(`--fallback-model is only supported with the Claude provider — ignored`));
    }
    return [];
  }
  const args: string[] = [];
  if (options.maxBudgetUsd != null) {
    args.push('--max-budget-usd', String(options.maxBudgetUsd));
  }
  if (options.fallbackModel) {
    args.push('--fallback-model', options.fallbackModel);
  }
  // Prevent runaway loops in headless mode — always set a turn limit
  args.push('--max-turns', String(options.maxTurns ?? DEFAULT_MAX_TURNS));
  return args;
}

async function executeTask(
  ctx: TaskContext,
  options: ExecutorOptions,
  sprintId: string,
  resumeSessionId?: string,
  provider?: ProviderAdapter,
  checkStatus?: CheckStatus
): Promise<TaskExecutionResult> {
  const p = provider ?? (await getActiveProvider());
  const label = p.displayName;
  const projectPath = ctx.task.projectPath;
  const sprintDir = getSprintDir(sprintId);

  if (options.session) {
    const contextFileName = getContextFileName(sprintId, ctx.task.id);
    const gitHistory = getRecentGitHistory(projectPath, 20);
    const checkScript = getEffectiveCheckScript(ctx.project, projectPath);
    const allProgress = await getProgress(sprintId);
    const progressSummary = summarizeProgressForContext(allProgress, projectPath, 3);
    const fullTaskContent = buildFullTaskContext(ctx, progressSummary || null, gitHistory, checkScript, checkStatus);
    const progressFilePath = getProgressFilePath(sprintId);
    const instructions = buildTaskExecutionPrompt(progressFilePath, options.noCommit, contextFileName);
    const contextFile = await writeTaskContextFile(projectPath, fullTaskContent, instructions, sprintId, ctx.task.id);

    try {
      const result = spawnInteractive(
        `Read ${contextFileName} and follow the instructions`,
        {
          cwd: projectPath,
          args: ['--add-dir', sprintDir],
          env: p.getSpawnEnv(),
        },
        p
      );

      if (result.error) {
        return { success: false, output: '', blockedReason: result.error, sessionId: null, model: null };
      }

      if (result.code === 0) {
        return { success: true, output: '', verified: true, sessionId: null, model: null };
      }
      return {
        success: false,
        output: '',
        blockedReason: `${label} exited with code ${String(result.code)}`,
        sessionId: null,
        model: null,
      };
    } finally {
      await unlink(contextFile).catch(() => undefined);
    }
  }

  // Headless mode
  let spawnResult: SpawnResult;

  if (resumeSessionId) {
    // Resume a previous session — send a short continuation prompt
    const spinner = createSpinner(`Resuming ${label} session for: ${ctx.task.name}`).start();

    // Register spinner cleanup with ProcessManager
    const manager = ProcessManager.getInstance();
    const deregister = manager.registerCleanup(() => {
      spinner.stop();
    });

    try {
      spawnResult = await spawnWithRetry(
        {
          cwd: projectPath,
          args: ['--add-dir', sprintDir, ...buildProviderArgs(options, p)],
          prompt: 'Continue where you left off. Complete the task and signal completion.',
          resumeSessionId,
          env: p.getSpawnEnv(),
        },
        {
          maxRetries: options.maxRetries,
          onRetry: (attempt, delayMs) => {
            spinner.text = `Rate limited, retrying in ${String(Math.round(delayMs / 1000))}s (attempt ${String(attempt)})...`;
          },
        },
        p
      );
      spinner.succeed(`${label} completed: ${ctx.task.name}`);
    } catch (err) {
      spinner.fail(`${label} failed: ${ctx.task.name}`);
      throw err;
    } finally {
      deregister();
    }
  } else {
    // Fresh session — build full context
    const contextFileName = getContextFileName(sprintId, ctx.task.id);
    const gitHistory = getRecentGitHistory(projectPath, 20);
    const checkScript = getEffectiveCheckScript(ctx.project, projectPath);
    const allProgress = await getProgress(sprintId);
    const progressSummary = summarizeProgressForContext(allProgress, projectPath, 3);
    const fullTaskContent = buildFullTaskContext(ctx, progressSummary || null, gitHistory, checkScript, checkStatus);
    const progressFilePath = getProgressFilePath(sprintId);
    const instructions = buildTaskExecutionPrompt(progressFilePath, options.noCommit, contextFileName);
    const contextFile = await writeTaskContextFile(projectPath, fullTaskContent, instructions, sprintId, ctx.task.id);

    const spinner = createSpinner(`${label} is working on: ${ctx.task.name}`).start();

    // Register spinner cleanup with ProcessManager
    const manager = ProcessManager.getInstance();
    const deregister = manager.registerCleanup(() => {
      spinner.stop();
    });

    try {
      const contextContent = await readFile(contextFile, 'utf-8');
      spawnResult = await spawnWithRetry(
        {
          cwd: projectPath,
          args: ['--add-dir', sprintDir, ...buildProviderArgs(options, p)],
          prompt: contextContent,
          env: p.getSpawnEnv(),
        },
        {
          maxRetries: options.maxRetries,
          onRetry: (attempt, delayMs) => {
            spinner.text = `Rate limited, retrying in ${String(Math.round(delayMs / 1000))}s (attempt ${String(attempt)})...`;
          },
        },
        p
      );
      spinner.succeed(`${label} completed: ${ctx.task.name}`);
    } catch (err) {
      spinner.fail(`${label} failed: ${ctx.task.name}`);
      throw err;
    } finally {
      deregister();
      await unlink(contextFile).catch(() => undefined);
    }
  }

  const parsed = parseExecutionResult(spawnResult.stdout);
  return { ...parsed, sessionId: spawnResult.sessionId, model: spawnResult.model };
}

// ============================================================================
// SHARED EVALUATION LOOP
// ============================================================================

/** Max characters to persist in evaluationOutput (prevents tasks.json bloat). */
const MAX_EVAL_OUTPUT = 2000;

/**
 * Run the evaluation loop for a completed task.
 * Shared between sequential and parallel executors to avoid duplication.
 *
 * Spawns an independent evaluator session, and if evaluation fails, resumes the
 * generator with critique, re-runs the check gate, and re-evaluates — up to
 * `evalIterations` times. Stores the evaluation result regardless of outcome.
 */
async function runEvaluationLoop(params: {
  task: Task;
  result: { sessionId: string | null; model: string | null };
  project: Project | undefined;
  sprintId: string;
  provider: ProviderAdapter;
  options: ExecutorOptions;
  evalIterations: number;
  checkTimeout?: number;
  useSpinner?: boolean;
}): Promise<void> {
  const {
    task,
    result,
    project,
    sprintId,
    provider,
    options,
    evalIterations,
    checkTimeout,
    useSpinner = false,
  } = params;

  const evalCheckScript = getEffectiveCheckScript(project, task.projectPath);
  const sprintDir = getSprintDir(sprintId);
  let evalResult = await runEvaluation(task, result.model, evalCheckScript, sprintId, provider);

  // Track the latest session ID and model across iterations — the generator may
  // produce new session IDs on each fix attempt, and we need the latest for resume.
  let currentSessionId = result.sessionId;
  let currentModel = result.model;

  for (let i = 0; i < evalIterations && !evalResult.passed; i++) {
    console.log(warning(`Evaluation failed for ${task.name} (iteration ${String(i + 1)}/${String(evalIterations)})`));
    console.log(muted(evalResult.output.slice(0, 500)));

    // Resume generator with critique
    const resumeSpinner = useSpinner ? createSpinner(`Fixing evaluation issues: ${task.name}`).start() : null;
    const resumeResult = await spawnWithRetry(
      {
        cwd: task.projectPath,
        args: ['--add-dir', sprintDir, ...buildProviderArgs(options, provider)],
        prompt: `The evaluator found issues with your implementation:\n\n${evalResult.output}\n\nReview the critique carefully. Fix each identified issue in the code, then:\n1. Re-run verification commands to confirm the fix\n${options.noCommit ? '' : '2. Commit the fix with a descriptive message\n'}${options.noCommit ? '2' : '3'}. Signal completion with <task-verified> and <task-complete>\n\nIf the critique is about something outside your task scope, fix only what is within scope and signal completion.`,
        resumeSessionId: currentSessionId ?? undefined,
        env: provider.getSpawnEnv(),
      },
      {
        maxRetries: options.maxRetries,
        ...(resumeSpinner
          ? {
              onRetry: (attempt: number, delayMs: number) => {
                resumeSpinner.text = `Rate limited, retrying in ${String(Math.round(delayMs / 1000))}s (attempt ${String(attempt)})...`;
              },
            }
          : {}),
      },
      provider
    );
    resumeSpinner?.succeed(`Fix attempt completed: ${task.name}`);

    // Capture latest session ID and model for subsequent iterations
    if (resumeResult.sessionId) currentSessionId = resumeResult.sessionId;
    if (resumeResult.model) currentModel = resumeResult.model;

    const fixResult = parseExecutionResult(resumeResult.stdout);
    if (!fixResult.success) {
      console.log(warning(`Generator could not fix issues after feedback: ${task.name}`));
      break;
    }

    // Re-run check script
    const recheckScript = getEffectiveCheckScript(project, task.projectPath);
    if (recheckScript) {
      const recheckResult = runLifecycleHook(task.projectPath, recheckScript, 'taskComplete', checkTimeout);
      if (!recheckResult.passed) {
        console.log(warning(`Post-task check failed after generator fix: ${task.name}`));
        break;
      }
    }

    // Re-evaluate using latest model from the fix attempt
    evalResult = await runEvaluation(task, currentModel, evalCheckScript, sprintId, provider);
  }

  // Store evaluation result (truncated to prevent tasks.json bloat)
  await updateTask(
    task.id,
    {
      evaluated: true,
      evaluationOutput: evalResult.output.slice(0, MAX_EVAL_OUTPUT),
    },
    sprintId
  );

  if (!evalResult.passed) {
    console.log(
      warning(`Evaluation did not pass after ${String(evalIterations)} iteration(s) — marking done: ${task.name}`)
    );
  } else {
    console.log(success(`Evaluation passed: ${task.name}`));
  }
}

// ============================================================================
// SEQUENTIAL EXECUTION LOOP
// ============================================================================

/**
 * Check if all remaining tasks are blocked by dependencies.
 */
async function areAllRemainingBlocked(sprintId: string): Promise<boolean> {
  const remaining = await getRemainingTasks(sprintId);
  if (remaining.length === 0) return false;

  for (const task of remaining) {
    if (task.status === 'in_progress') return false;
    const blocked = await isTaskBlocked(task.id, sprintId);
    if (!blocked) return false;
  }
  return true;
}

/**
 * Sequential execution loop - executes tasks one at a time.
 * Used for session mode, step mode, or --concurrency 1.
 */
export async function executeTaskLoop(
  sprintId: string,
  options: ExecutorOptions,
  checkResults?: CheckResults
): Promise<ExecutionSummary> {
  // Install signal handlers eagerly so Ctrl+C works before the first child spawns
  ProcessManager.getInstance().ensureHandlers();

  // Resolve provider and evaluation config once for the entire loop
  const provider = await getActiveProvider();
  const label = provider.displayName;
  const evalIterations = await getEvaluationIterations();

  const sprint = await getSprint(sprintId);
  let completedCount = 0;
  const targetCount = options.count ?? Infinity;

  // Check for resumability - find in_progress task
  const firstTask = await getNextTask(sprintId);
  if (firstTask?.status === 'in_progress') {
    console.log(warning(`\nResuming from: ${firstTask.id} - ${firstTask.name}`));
  }

  // Main implementation loop
  while (completedCount < targetCount) {
    // Break immediately if shutdown is in progress (Ctrl+C)
    const manager = ProcessManager.getInstance();
    if (manager.isShuttingDown()) {
      const remaining = await getRemainingTasks(sprintId);
      return {
        completed: completedCount,
        remaining: remaining.length,
        stopReason: 'task_blocked',
        blockedTask: null,
        blockedReason: 'Interrupted by user',
        exitCode: EXIT_ERROR,
      };
    }

    const task = await getNextTask(sprintId);

    if (!task) {
      // Check if all remaining tasks are blocked
      if (await areAllRemainingBlocked(sprintId)) {
        const remaining = await getRemainingTasks(sprintId);
        return {
          completed: completedCount,
          remaining: remaining.length,
          stopReason: 'all_blocked',
          blockedTask: null,
          blockedReason: 'All remaining tasks are blocked by dependencies',
          exitCode: EXIT_ALL_BLOCKED,
        };
      }

      // Truly no tasks
      const remaining = await getRemainingTasks(sprintId);
      if (remaining.length === 0 && completedCount === 0) {
        return {
          completed: 0,
          remaining: 0,
          stopReason: 'no_tasks',
          blockedTask: null,
          blockedReason: null,
          exitCode: EXIT_NO_TASKS,
        };
      }

      console.log(success('\nAll tasks completed!'));
      return {
        completed: completedCount,
        remaining: 0,
        stopReason: 'all_completed',
        blockedTask: null,
        blockedReason: null,
        exitCode: EXIT_SUCCESS,
      };
    }

    console.log(info(`\n--- Task ${String(task.order)}: ${task.name} ---`));
    console.log(info('ID:      ') + task.id);
    console.log(info('Project: ') + task.projectPath);
    console.log(info('Status:  ') + formatTaskStatus(task.status));

    // Mark as in_progress if not already
    if (task.status !== 'in_progress') {
      await updateTaskStatus(task.id, 'in_progress', sprintId);
      console.log(muted('Status updated to: in_progress'));
    }

    // Get project for the task (if available)
    const project = await getProjectForTask(task, sprint);

    // Build context for AI provider
    const ctx: TaskContext = { sprint, task, project };
    const taskPrompt = formatTask(ctx);

    // Run permission check (only on first task of the loop)
    if (completedCount === 0) {
      runPermissionCheck(ctx, options.noCommit, provider.name);
    }

    // Branch verification (if sprint has a branch set)
    if (sprint.branch) {
      if (!verifySprintBranch(task.projectPath, sprint.branch)) {
        console.log(warning(`\nBranch verification failed: expected '${sprint.branch}' in ${task.projectPath}`));
        console.log(muted(`Task ${task.id} remains in_progress.`));
        const remaining = await getRemainingTasks(sprintId);
        return {
          completed: completedCount,
          remaining: remaining.length,
          stopReason: 'task_blocked',
          blockedTask: task,
          blockedReason: `Repository ${task.projectPath} is not on expected branch '${sprint.branch}'`,
          exitCode: EXIT_ERROR,
        };
      }
    }

    if (options.session) {
      console.log(highlight(`\n[Task Context for ${label}]`));
      console.log(muted('─'.repeat(50)));
      console.log(taskPrompt);
      console.log(muted('─'.repeat(50)));
      console.log(muted(`\nStarting ${label} in ${task.projectPath} (session)...\n`));
    } else {
      console.log(muted(`Starting ${label} in ${task.projectPath} (headless)...`));
    }

    // Execute task with AI provider
    const result = await executeTask(ctx, options, sprintId, undefined, provider, checkResults?.get(task.projectPath));

    if (!result.success) {
      console.log(warning('\nTask not completed.'));
      if (result.blockedReason) {
        console.log(warning(`Reason: ${result.blockedReason}`));
      }
      console.log(muted('\nExecution paused. Task remains in_progress.'));
      console.log(muted(`Resume with: ralphctl sprint start ${sprintId}\n`));

      const remaining = await getRemainingTasks(sprintId);
      return {
        completed: completedCount,
        remaining: remaining.length,
        stopReason: 'task_blocked',
        blockedTask: task,
        blockedReason: result.blockedReason ?? 'Unknown reason',
        exitCode: EXIT_ERROR,
      };
    }

    // Store verification result if available
    if (result.verified) {
      await updateTask(
        task.id,
        {
          verified: true,
          verificationOutput: result.verificationOutput,
        },
        sprintId
      );
      console.log(success('Verification: passed'));
    }

    // Post-task check hook — run checkScript as a gate before marking done
    const checkScript = getEffectiveCheckScript(project, task.projectPath);
    if (checkScript) {
      console.log(muted(`Running post-task check: ${checkScript}`));
      const hookResult = runLifecycleHook(task.projectPath, checkScript, 'taskComplete');
      if (!hookResult.passed) {
        console.log(warning(`\nPost-task check failed for: ${task.name}`));
        console.log(muted('Task remains in_progress. Execution paused.'));
        console.log(muted(`Resume with: ralphctl sprint start ${sprintId}\n`));
        const remaining = await getRemainingTasks(sprintId);
        return {
          completed: completedCount,
          remaining: remaining.length,
          stopReason: 'task_blocked',
          blockedTask: task,
          blockedReason: `Post-task check failed: ${hookResult.output.slice(0, 500)}`,
          exitCode: EXIT_ERROR,
        };
      }
      console.log(success('Post-task check: passed'));
    }

    // Evaluation loop (if enabled)
    if (evalIterations > 0 && !options.noEvaluate && !options.session) {
      await runEvaluationLoop({
        task,
        result,
        project,
        sprintId,
        provider,
        options,
        evalIterations,
        useSpinner: true,
      });
    }

    // Update task status: in_progress → done
    await updateTaskStatus(task.id, 'done', sprintId);
    console.log(success('Status updated to: done'));

    // Log automatic progress
    await logProgress(
      `Completed task: ${task.id} - ${task.name}\n\n` +
        (task.description ? `Description: ${task.description}\n` : '') +
        (task.steps.length > 0 ? `Steps:\n${task.steps.map((s, i) => `  ${String(i + 1)}. ${s}`).join('\n')}` : ''),
      { sprintId, projectPath: task.projectPath }
    );

    completedCount++;

    // Interactive mode: confirm before continuing
    if (options.step && completedCount < targetCount) {
      const remaining = await getRemainingTasks(sprintId);
      if (remaining.length > 0) {
        console.log(info(`\n${String(remaining.length)} task(s) remaining.`));
        const continueLoop = await confirm({
          message: 'Continue to next task?',
          default: true,
        });
        if (!continueLoop) {
          console.log(muted('\nExecution paused.'));
          console.log(muted(`Resume with: ralphctl sprint start ${sprintId}\n`));
          return {
            completed: completedCount,
            remaining: remaining.length,
            stopReason: 'user_paused',
            blockedTask: null,
            blockedReason: null,
            exitCode: EXIT_SUCCESS,
          };
        }
      }
    }
  }

  // Reached count limit
  const remaining = await getRemainingTasks(sprintId);
  return {
    completed: completedCount,
    remaining: remaining.length,
    stopReason: remaining.length === 0 ? 'all_completed' : 'count_reached',
    blockedTask: null,
    blockedReason: null,
    exitCode: EXIT_SUCCESS,
  };
}

// ============================================================================
// PARALLEL EXECUTION LOOP
// ============================================================================

interface ParallelTaskResult {
  task: Task;
  result: TaskExecutionResult | null;
  error: Error | null;
  /** Whether this failure is a rate limit (should retry, not count as failure) */
  isRateLimited: boolean;
}

/**
 * Pick tasks to launch: one per unique projectPath, respecting concurrency limit.
 * Excludes repos that already have an in-flight task or have failed checks.
 */
export function pickTasksToLaunch(
  readyTasks: Task[],
  inFlightPaths: Set<string>,
  concurrencyLimit: number,
  currentInFlight: number,
  failedPaths?: Set<string>
): Task[] {
  const available = readyTasks.filter(
    (t) => !inFlightPaths.has(t.projectPath) && !(failedPaths?.has(t.projectPath) ?? false)
  );

  // Deduplicate by projectPath — pick the first (lowest order) task per repo
  const byPath = new Map<string, Task>();
  for (const task of available) {
    if (!byPath.has(task.projectPath)) {
      byPath.set(task.projectPath, task);
    }
  }

  const candidates = [...byPath.values()];
  const slotsAvailable = concurrencyLimit - currentInFlight;
  return candidates.slice(0, Math.max(0, slotsAvailable));
}

/**
 * Parallel execution loop - runs tasks concurrently across different repos.
 * At most one task per projectPath runs at a time to avoid git conflicts.
 */
export async function executeTaskLoopParallel(
  sprintId: string,
  options: ExecutorOptions,
  checkResults?: CheckResults
): Promise<ExecutionSummary> {
  // Install signal handlers eagerly so Ctrl+C works before the first child spawns
  ProcessManager.getInstance().ensureHandlers();

  // Resolve provider and evaluation config once for the entire loop
  const provider = await getActiveProvider();
  const label = provider.displayName;
  const evalIterations = await getEvaluationIterations();

  const sprint = await getSprint(sprintId);
  let completedCount = 0;
  const targetCount = options.count ?? Infinity;
  const failFast = options.failFast ?? true;
  let hasFailed = false;
  let firstBlockedTask: Task | null = null;
  let firstBlockedReason: string | null = null;

  // Determine concurrency limit (hard cap prevents resource exhaustion)
  const MAX_CONCURRENCY = 10;
  const allTasks = await getTasks(sprintId);
  const uniqueRepoPaths = new Set(allTasks.map((t) => t.projectPath));
  const concurrencyLimit = Math.min(options.concurrency ?? uniqueRepoPaths.size, MAX_CONCURRENCY);

  console.log(muted(`Parallel mode: up to ${String(concurrencyLimit)} concurrent task(s)`));

  // Set up rate limit coordinator
  const coordinator = new RateLimitCoordinator({
    onPause: (delayMs) => {
      console.log(warning(`\nRate limited. Pausing new launches for ${String(Math.round(delayMs / 1000))}s...`));
    },
    onResume: () => {
      console.log(success('Rate limit cooldown ended. Resuming launches.'));
    },
  });

  // Track in-flight tasks and session IDs for resume
  const inFlightPaths = new Set<string>();
  const running = new Map<string, Promise<ParallelTaskResult>>();
  const taskSessionIds = new Map<string, string>(); // taskId → AI session ID
  const branchRetries = new Map<string, number>(); // taskId → branch verification attempts
  const failedPaths = new Set<string>(); // repos where post-task checks failed
  const MAX_BRANCH_RETRIES = 3;
  let permissionCheckDone = false;

  try {
    // Check for resumable in_progress tasks
    const inProgressTasks = allTasks.filter((t) => t.status === 'in_progress');
    if (inProgressTasks.length > 0) {
      console.log(warning(`\nResuming ${String(inProgressTasks.length)} in-progress task(s):`));
      for (const t of inProgressTasks) {
        console.log(warning(`  - ${t.id}: ${t.name}`));
      }
    }

    while (completedCount < targetCount) {
      // Break immediately if shutdown is in progress (Ctrl+C)
      const manager = ProcessManager.getInstance();
      if (manager.isShuttingDown()) {
        break;
      }

      // Wait if rate limited before checking for new tasks
      await coordinator.waitIfPaused();

      // Get current task state from disk
      const readyTasks = await getReadyTasks(sprintId);

      // Also check for in_progress tasks (resumable)
      const currentTasks = await getTasks(sprintId);
      const inProgress = currentTasks.filter((t) => t.status === 'in_progress' && !running.has(t.id));

      // Combine: resume in_progress first, then ready tasks
      const launchCandidates = [...inProgress, ...readyTasks.filter((t) => !inProgress.some((ip) => ip.id === t.id))];

      if (launchCandidates.length === 0 && running.size === 0) {
        // Nothing to run and nothing in flight
        const remaining = await getRemainingTasks(sprintId);
        if (remaining.length === 0) {
          if (completedCount === 0) {
            return {
              completed: 0,
              remaining: 0,
              stopReason: 'no_tasks',
              blockedTask: null,
              blockedReason: null,
              exitCode: EXIT_NO_TASKS,
            };
          }
          console.log(success('\nAll tasks completed!'));
          return {
            completed: completedCount,
            remaining: 0,
            stopReason: 'all_completed',
            blockedTask: null,
            blockedReason: null,
            exitCode: EXIT_SUCCESS,
          };
        }

        // Tasks exist but none are launchable — all blocked
        const hasFailures = hasFailed || failedPaths.size > 0;
        if (failedPaths.size > 0) {
          console.log(warning(`\nRepos with failed checks: ${[...failedPaths].join(', ')}`));
        }
        return {
          completed: completedCount,
          remaining: remaining.length,
          stopReason: hasFailures ? 'task_blocked' : 'all_blocked',
          blockedTask: firstBlockedTask,
          blockedReason: firstBlockedReason ?? 'All remaining tasks are blocked by dependencies',
          exitCode: hasFailures ? EXIT_ERROR : EXIT_ALL_BLOCKED,
        };
      }

      // Pick tasks to launch (if we should)
      // Per-repo failures don't block other repos — only global hasFailed (branch failures) respects failFast
      if (!hasFailed || !failFast) {
        const toStart = pickTasksToLaunch(launchCandidates, inFlightPaths, concurrencyLimit, running.size, failedPaths);

        for (const task of toStart) {
          if (completedCount + running.size >= targetCount) break;

          // Cache project lookup — reused for permission check and execution
          const project = await getProjectForTask(task, sprint);

          // Run permission check once (before any task starts)
          if (!permissionCheckDone) {
            const ctx: TaskContext = { sprint, task, project };
            runPermissionCheck(ctx, options.noCommit, provider.name);
            permissionCheckDone = true;
          }

          // Branch verification (if sprint has a branch set)
          if (sprint.branch) {
            if (!verifySprintBranch(task.projectPath, sprint.branch)) {
              const attempt = (branchRetries.get(task.id) ?? 0) + 1;
              branchRetries.set(task.id, attempt);

              if (attempt < MAX_BRANCH_RETRIES) {
                // Transient failure — re-enqueue for retry (similar to rate-limited tasks)
                console.log(
                  warning(
                    `\n  Branch verification failed (attempt ${String(attempt)}/${String(MAX_BRANCH_RETRIES)}): expected '${sprint.branch}' in ${task.projectPath}`
                  )
                );
                console.log(muted(`  Task ${task.id} will retry on next loop iteration.`));
                continue;
              }

              // Exhausted retries — treat as a real failure
              console.log(
                warning(
                  `\n  Branch verification failed after ${String(MAX_BRANCH_RETRIES)} attempts: expected '${sprint.branch}' in ${task.projectPath}`
                )
              );
              console.log(muted(`  Task ${task.id} not started — wrong branch.`));
              hasFailed = true;
              if (!firstBlockedTask) {
                firstBlockedTask = task;
                firstBlockedReason = `Repository ${task.projectPath} is not on expected branch '${sprint.branch}'`;
              }
              if (failFast) {
                console.log(muted('Fail-fast: waiting for running tasks to finish...'));
              }
              continue;
            }
          }

          // Mark as in_progress only after pre-flight passes
          if (task.status !== 'in_progress') {
            await updateTaskStatus(task.id, 'in_progress', sprintId);
          }

          // Check if we have a session ID to resume from (rate-limit recovery)
          const resumeId = taskSessionIds.get(task.id);
          const action = resumeId ? 'Resuming' : 'Starting';

          console.log(info(`\n--- ${action} task ${String(task.order)}: ${task.name} ---`));
          console.log(info('ID:      ') + task.id);
          console.log(info('Project: ') + task.projectPath);
          if (resumeId) {
            console.log(muted(`Resuming ${label} session ${resumeId.slice(0, 8)}...`));
          } else {
            console.log(muted(`Starting ${label} in ${task.projectPath} (headless)...`));
          }

          inFlightPaths.add(task.projectPath);

          const taskPromise = (async (): Promise<ParallelTaskResult> => {
            const ctx: TaskContext = { sprint, task, project };
            const resultR = await wrapAsync(
              () => executeTask(ctx, options, sprintId, resumeId, provider, checkResults?.get(task.projectPath)),
              ensureError
            );
            inFlightPaths.delete(task.projectPath); // always runs — was in finally

            if (!resultR.ok) {
              const err = resultR.error;
              if (err instanceof SpawnError && err.rateLimited) {
                // Store session ID from error for resume after cooldown
                if (err.sessionId) {
                  taskSessionIds.set(task.id, err.sessionId);
                }
                coordinator.pause(err.retryAfterMs ?? 60_000);
                return { task, result: null, error: err, isRateLimited: true };
              }
              return { task, result: null, error: err, isRateLimited: false };
            }

            const result = resultR.value;
            // Store session ID for potential future resume
            if (result.sessionId) {
              taskSessionIds.set(task.id, result.sessionId);
            }
            return { task, result, error: null, isRateLimited: false };
          })();

          running.set(task.id, taskPromise);
        }
      }

      // Wait for any task to complete
      if (running.size === 0) {
        // Check if any tasks are pending branch retry before giving up
        const hasPendingBranchRetry = [...branchRetries.entries()].some(([, count]) => count < MAX_BRANCH_RETRIES);
        if (hasPendingBranchRetry) {
          // Brief delay before retrying to avoid tight-looping
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
        // Nothing launched, nothing running, no retries pending — stop
        break;
      }

      // Wait for first task to complete, then check rate limit state and launch next batch
      const settled = await Promise.race([...running.values()]);
      running.delete(settled.task.id);

      // Process the result
      if (settled.error) {
        if (settled.isRateLimited) {
          // Rate limit — not a real failure, will be re-queued after cooldown
          const sessionId = taskSessionIds.get(settled.task.id);
          console.log(warning(`\nRate limited: ${settled.task.name}`));
          if (sessionId) {
            console.log(muted(`Session saved for resume: ${sessionId.slice(0, 8)}...`));
          }
          console.log(muted('Will retry after cooldown.'));
          // Don't set hasFailed — this task will be re-launched on next loop iteration
          continue;
        }

        // Real error
        console.log(warning(`\nTask failed: ${settled.task.name}`));
        console.log(warning(`Error: ${settled.error.message}`));
        console.log(muted(`Task ${settled.task.id} remains in_progress for resumption.`));

        hasFailed = true;
        if (!firstBlockedTask) {
          firstBlockedTask = settled.task;
          firstBlockedReason = settled.error.message;
        }

        if (failFast) {
          console.log(muted('Fail-fast: waiting for running tasks to finish...'));
        }
        continue;
      }

      if (settled.result && !settled.result.success) {
        console.log(warning(`\nTask not completed: ${settled.task.name}`));
        if (settled.result.blockedReason) {
          console.log(warning(`Reason: ${settled.result.blockedReason}`));
        }
        console.log(muted(`Task ${settled.task.id} remains in_progress.`));

        hasFailed = true;
        if (!firstBlockedTask) {
          firstBlockedTask = settled.task;
          firstBlockedReason = settled.result.blockedReason ?? 'Unknown reason';
        }

        if (failFast) {
          console.log(muted('Fail-fast: waiting for running tasks to finish...'));
        }
        continue;
      }

      // Task completed successfully
      if (settled.result) {
        // Store verification result
        if (settled.result.verified) {
          await updateTask(
            settled.task.id,
            {
              verified: true,
              verificationOutput: settled.result.verificationOutput,
            },
            sprintId
          );
          console.log(success(`Verification passed: ${settled.task.name}`));
        }

        // Post-task check hook
        const taskProject = await getProjectForTask(settled.task, sprint);
        const taskCheckScript = getEffectiveCheckScript(taskProject, settled.task.projectPath);
        if (taskCheckScript) {
          const taskRepo = taskProject?.repositories.find((r) => r.path === settled.task.projectPath);
          const hookResult = runLifecycleHook(
            settled.task.projectPath,
            taskCheckScript,
            'taskComplete',
            taskRepo?.checkTimeout
          );
          if (!hookResult.passed) {
            console.log(warning(`\nPost-task check failed for: ${settled.task.name}`));
            console.log(muted(`Task ${settled.task.id} remains in_progress. Repo ${settled.task.projectPath} paused.`));
            failedPaths.add(settled.task.projectPath);
            if (!firstBlockedTask) {
              firstBlockedTask = settled.task;
              firstBlockedReason = `Post-task check failed: ${hookResult.output.slice(0, 500)}`;
            }
            continue;
          }
          console.log(success(`Post-task check passed: ${settled.task.name}`));
        }

        // Evaluation loop (if enabled)
        if (evalIterations > 0 && !options.noEvaluate && !options.session) {
          const taskRepo = taskProject?.repositories.find((r) => r.path === settled.task.projectPath);
          await runEvaluationLoop({
            task: settled.task,
            result: settled.result,
            project: taskProject,
            sprintId,
            provider,
            options,
            evalIterations,
            checkTimeout: taskRepo?.checkTimeout,
          });
        }

        // Mark done
        await updateTaskStatus(settled.task.id, 'done', sprintId);
        console.log(success(`Completed: ${settled.task.name}`));

        // Clean up session tracking
        taskSessionIds.delete(settled.task.id);

        // Log progress
        await logProgress(
          `Completed task: ${settled.task.id} - ${settled.task.name}\n\n` +
            (settled.task.description ? `Description: ${settled.task.description}\n` : '') +
            (settled.task.steps.length > 0
              ? `Steps:\n${settled.task.steps.map((s, i) => `  ${String(i + 1)}. ${s}`).join('\n')}`
              : ''),
          { sprintId, projectPath: settled.task.projectPath }
        );

        completedCount++;
      }
    }

    // Wait for any remaining in-flight tasks
    if (running.size > 0) {
      console.log(muted(`\nWaiting for ${String(running.size)} remaining task(s)...`));
      const remaining = await Promise.allSettled([...running.values()]);
      for (const r of remaining) {
        if (r.status === 'fulfilled' && r.value.result?.success) {
          if (r.value.result.verified) {
            await updateTask(
              r.value.task.id,
              { verified: true, verificationOutput: r.value.result.verificationOutput },
              sprintId
            );
          }
          // Post-task check hook
          const drainProject = await getProjectForTask(r.value.task, sprint);
          const drainCheckScript = getEffectiveCheckScript(drainProject, r.value.task.projectPath);
          if (drainCheckScript) {
            const drainRepo = drainProject?.repositories.find((repo) => repo.path === r.value.task.projectPath);
            const hookResult = runLifecycleHook(
              r.value.task.projectPath,
              drainCheckScript,
              'taskComplete',
              drainRepo?.checkTimeout
            );
            if (!hookResult.passed) {
              console.log(warning(`Post-task check failed for: ${r.value.task.name}`));
              continue;
            }
          }
          await updateTaskStatus(r.value.task.id, 'done', sprintId);
          console.log(success(`Completed: ${r.value.task.name}`));
          await logProgress(`Completed task: ${r.value.task.id} - ${r.value.task.name}`, {
            sprintId,
            projectPath: r.value.task.projectPath,
          });
          completedCount++;
        }
      }
    }
  } finally {
    coordinator.dispose();
  }

  const remainingTasks = await getRemainingTasks(sprintId);

  if (hasFailed) {
    return {
      completed: completedCount,
      remaining: remainingTasks.length,
      stopReason: 'task_blocked',
      blockedTask: firstBlockedTask,
      blockedReason: firstBlockedReason,
      exitCode: EXIT_ERROR,
    };
  }

  return {
    completed: completedCount,
    remaining: remainingTasks.length,
    stopReason: remainingTasks.length === 0 ? 'all_completed' : 'count_reached',
    blockedTask: null,
    blockedReason: null,
    exitCode: EXIT_SUCCESS,
  };
}
