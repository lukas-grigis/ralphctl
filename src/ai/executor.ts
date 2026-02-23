import { confirm } from '@inquirer/prompts';
import { readFile, unlink } from 'node:fs/promises';
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
import type { Task } from '@src/schemas/index.ts';
import { createSpinner, formatTaskStatus } from '@src/theme/ui.ts';
import { type ExecutionResult, parseExecutionResult } from '@src/ai/parser.ts';
import type { SpawnResult } from '@src/ai/session.ts';
import { SpawnError, spawnInteractive, spawnWithRetry } from '@src/ai/session.ts';
import { RateLimitCoordinator } from '@src/ai/rate-limiter.ts';
import { EXIT_ALL_BLOCKED, EXIT_ERROR, EXIT_NO_TASKS, EXIT_SUCCESS } from '@src/utils/exit-codes.ts';
import { getSprint } from '@src/store/sprint.ts';
import {
  buildFullTaskContext,
  formatTask,
  getContextFileName,
  getEffectiveVerifyScript,
  getProjectForTask,
  getRecentGitHistory,
  runPreFlightCheck,
  type TaskContext,
  writeTaskContextFile,
} from '@src/ai/task-context.ts';
import { type ProviderAdapter } from '@src/providers/types.ts';
import { getActiveProvider } from '@src/providers/index.ts';

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
  /** Skip running setupScript on repositories before task execution */
  skipSetup?: boolean;
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
}

async function executeTask(
  ctx: TaskContext,
  options: ExecutorOptions,
  sprintId: string,
  resumeSessionId?: string,
  provider?: ProviderAdapter
): Promise<TaskExecutionResult> {
  const p = provider ?? (await getActiveProvider());
  const label = p.displayName;
  const projectPath = ctx.task.projectPath;
  const sprintDir = getSprintDir(sprintId);

  if (options.session) {
    const contextFileName = getContextFileName(sprintId, ctx.task.id);
    const gitHistory = getRecentGitHistory(projectPath, 20);
    const verifyScript = getEffectiveVerifyScript(ctx.project, projectPath);
    const allProgress = await getProgress(sprintId);
    const progressSummary = summarizeProgressForContext(allProgress, projectPath, 3);
    const fullTaskContent = buildFullTaskContext(ctx, progressSummary || null, gitHistory, verifyScript);
    const progressFilePath = getProgressFilePath(sprintId);
    const instructions = buildTaskExecutionPrompt(progressFilePath, options.noCommit, contextFileName);
    const contextFile = await writeTaskContextFile(projectPath, fullTaskContent, instructions, sprintId, ctx.task.id);

    try {
      const result = spawnInteractive(
        `Read ${contextFileName} and follow the instructions`,
        {
          cwd: projectPath,
          args: ['--add-dir', sprintDir],
        },
        p
      );

      if (result.error) {
        return { success: false, output: '', blockedReason: result.error, sessionId: null };
      }

      if (result.code === 0) {
        return { success: true, output: '', verified: true, sessionId: null };
      }
      return {
        success: false,
        output: '',
        blockedReason: `${label} exited with code ${String(result.code)}`,
        sessionId: null,
      };
    } finally {
      try {
        await unlink(contextFile);
      } catch {
        // Ignore cleanup errors
      }
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
          args: ['--add-dir', sprintDir],
          prompt: 'Continue where you left off. Complete the task and signal completion.',
          resumeSessionId,
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
      deregister(); // Clean up callback registration
    }
  } else {
    // Fresh session — build full context
    const contextFileName = getContextFileName(sprintId, ctx.task.id);
    const gitHistory = getRecentGitHistory(projectPath, 20);
    const verifyScript = getEffectiveVerifyScript(ctx.project, projectPath);
    const allProgress = await getProgress(sprintId);
    const progressSummary = summarizeProgressForContext(allProgress, projectPath, 3);
    const fullTaskContent = buildFullTaskContext(ctx, progressSummary || null, gitHistory, verifyScript);
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
          args: ['--add-dir', sprintDir],
          prompt: contextContent,
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
      deregister(); // Clean up callback registration
      try {
        await unlink(contextFile);
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  const parsed = parseExecutionResult(spawnResult.stdout);
  return { ...parsed, sessionId: spawnResult.sessionId };
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
export async function executeTaskLoop(sprintId: string, options: ExecutorOptions): Promise<ExecutionSummary> {
  // Install signal handlers eagerly so Ctrl+C works before the first child spawns
  ProcessManager.getInstance().ensureHandlers();

  // Resolve provider once for the entire loop
  const provider = await getActiveProvider();
  const label = provider.displayName;

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

    // Run pre-flight permission check (only on first task of the loop)
    if (completedCount === 0) {
      runPreFlightCheck(ctx, options.noCommit, provider.name);
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
    const result = await executeTask(ctx, options, sprintId, undefined, provider);

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
 * Excludes repos that already have an in-flight task.
 */
function pickTasksToLaunch(
  readyTasks: Task[],
  inFlightPaths: Set<string>,
  concurrencyLimit: number,
  currentInFlight: number
): Task[] {
  const available = readyTasks.filter((t) => !inFlightPaths.has(t.projectPath));

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
export async function executeTaskLoopParallel(sprintId: string, options: ExecutorOptions): Promise<ExecutionSummary> {
  // Install signal handlers eagerly so Ctrl+C works before the first child spawns
  ProcessManager.getInstance().ensureHandlers();

  // Resolve provider once for the entire loop
  const provider = await getActiveProvider();
  const label = provider.displayName;

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
  let preFlightDone = false;

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
        return {
          completed: completedCount,
          remaining: remaining.length,
          stopReason: hasFailed ? 'task_blocked' : 'all_blocked',
          blockedTask: firstBlockedTask,
          blockedReason: firstBlockedReason ?? 'All remaining tasks are blocked by dependencies',
          exitCode: hasFailed ? EXIT_ERROR : EXIT_ALL_BLOCKED,
        };
      }

      // Pick tasks to launch (if we should)
      if (!hasFailed || !failFast) {
        const toStart = pickTasksToLaunch(launchCandidates, inFlightPaths, concurrencyLimit, running.size);

        for (const task of toStart) {
          if (completedCount + running.size >= targetCount) break;

          // Run pre-flight check once
          if (!preFlightDone) {
            const project = await getProjectForTask(task, sprint);
            const ctx: TaskContext = { sprint, task, project };
            runPreFlightCheck(ctx, options.noCommit, provider.name);
            preFlightDone = true;
          }

          // Mark as in_progress
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
            try {
              const project = await getProjectForTask(task, sprint);
              const ctx: TaskContext = { sprint, task, project };
              const result = await executeTask(ctx, options, sprintId, resumeId, provider);

              // Store session ID for potential future resume
              if (result.sessionId) {
                taskSessionIds.set(task.id, result.sessionId);
              }

              return { task, result, error: null, isRateLimited: false };
            } catch (err) {
              if (err instanceof SpawnError && err.rateLimited) {
                // Store session ID from error for resume after cooldown
                if (err.sessionId) {
                  taskSessionIds.set(task.id, err.sessionId);
                }
                const delay = err.retryAfterMs ?? 60_000;
                coordinator.pause(delay);

                return {
                  task,
                  result: null,
                  error: err,
                  isRateLimited: true,
                };
              }

              return {
                task,
                result: null,
                error: err instanceof Error ? err : new Error(String(err)),
                isRateLimited: false,
              };
            } finally {
              inFlightPaths.delete(task.projectPath);
            }
          })();

          running.set(task.id, taskPromise);
        }
      }

      // Wait for any task to complete
      if (running.size === 0) {
        // Nothing launched and nothing running — stop
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

// Re-export for backward compatibility
export { formatTask as formatTaskContext } from '@src/ai/task-context.ts';
// Re-export TaskContext type for consumers
export type { TaskContext } from '@src/ai/task-context.ts';
