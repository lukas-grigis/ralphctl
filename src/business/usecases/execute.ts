import type { Task, Sprint, Project } from '@src/domain/models.ts';
import { DomainError, SpawnError, SprintNotFoundError, SprintStatusError, StorageError } from '@src/domain/errors.ts';
import { Result } from '@src/domain/types.ts';
import type { ExecutionOptions } from '@src/domain/context.ts';
import type { PersistencePort } from '@src/domain/repositories/persistence.ts';
import type { AiSessionPort } from '../ports/ai-session.ts';
import type { PromptBuilderPort } from '../ports/prompt-builder.ts';
import type { OutputParserPort } from '../ports/output-parser.ts';
import type { UserInteractionPort } from '../ports/user-interaction.ts';
import type { LoggerPort } from '../ports/logger.ts';
import type { ExternalPort } from '../ports/external.ts';
import type { FilesystemPort } from '@src/domain/repositories/filesystem.ts';
import type { SignalParserPort } from '../ports/signal-parser.ts';
import type { SignalHandlerPort, SignalContext } from '../ports/signal-handler.ts';
import type { SignalBusPort } from '../ports/signal-bus.ts';
import type { HarnessSignal } from '@src/domain/signals.ts';
import { EvaluateTaskUseCase } from './evaluate.ts';
import { RateLimitCoordinator } from '@src/integration/ai/rate-limiter.ts';
import { ProcessManager } from '@src/integration/ai/process-manager.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EXIT_SUCCESS = 0;
const EXIT_ERROR = 1;
const EXIT_NO_TASKS = 2;
const EXIT_ALL_BLOCKED = 3;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StopReason =
  | 'all_completed'
  | 'count_reached'
  | 'task_blocked'
  | 'user_paused'
  | 'no_tasks'
  | 'all_blocked';

export interface ExecutionSummary {
  completed: number;
  remaining: number;
  blocked: number;
  stopReason: StopReason;
  exitCode: number;
}

export interface TaskExecutionResult {
  taskId: string;
  success: boolean;
  output: string;
  sessionId?: string;
  blocked?: string;
  verified?: boolean;
  verificationOutput?: string;
  model?: string;
}

interface ParallelTaskResult {
  task: Task;
  result: TaskExecutionResult | null;
  error: Error | null;
  /** Whether this failure is a rate limit (should retry, not count as failure) */
  isRateLimited: boolean;
}

// ---------------------------------------------------------------------------
// Use Case
// ---------------------------------------------------------------------------

export class ExecuteTasksUseCase {
  private readonly evaluator: EvaluateTaskUseCase;

  constructor(
    private readonly persistence: PersistencePort,
    private readonly aiSession: AiSessionPort,
    private readonly promptBuilder: PromptBuilderPort,
    private readonly parser: OutputParserPort,
    private readonly ui: UserInteractionPort,
    private readonly logger: LoggerPort,
    private readonly external: ExternalPort,
    private readonly fs: FilesystemPort,
    private readonly signalParser: SignalParserPort,
    private readonly signalHandler: SignalHandlerPort,
    private readonly signalBus: SignalBusPort
  ) {
    this.evaluator = new EvaluateTaskUseCase(persistence, aiSession, promptBuilder, parser, ui, logger, fs);
  }

  async execute(sprintId: string, options?: ExecutionOptions): Promise<Result<ExecutionSummary, DomainError>> {
    const log = this.logger.child({ sprintId });

    try {
      // 1. Resolve sprint
      let sprint = await this.resolveAndValidateSprint(sprintId);

      // 2. Precondition checks (draft only, skipped with --force)
      if (sprint.status === 'draft' && !options?.force) {
        const shouldContinue = await this.checkPreconditions(sprint);
        if (!shouldContinue) {
          return Result.ok({
            completed: 0,
            remaining: 0,
            blocked: 0,
            stopReason: 'user_paused',
            exitCode: EXIT_SUCCESS,
          });
        }
      }

      // 3. Resolve branch strategy BEFORE activation (prompt while still interactable)
      const branchName = await this.resolveBranchName(sprint, options);

      // 4. Auto-activate if draft
      if (sprint.status === 'draft') {
        sprint = await this.persistence.activateSprint(sprintId);
      }

      if (sprint.status !== 'active') {
        return Result.error(
          new SprintStatusError(`Sprint '${sprint.name}' is ${sprint.status}, expected active`, sprint.status, 'start')
        );
      }

      // 5. Validate and prepare tasks
      const tasks = await this.prepareTasksOrFail(sprint.id);
      if (tasks.length === 0) {
        return Result.ok({ completed: 0, remaining: 0, blocked: 0, stopReason: 'no_tasks', exitCode: EXIT_NO_TASKS });
      }

      // 6. Branch management
      if (branchName) {
        await this.ensureBranches(sprint, tasks, branchName);
      }

      // 7. Run check scripts
      const stopCheck = log.time('check-scripts');
      await this.runCheckScripts(sprint, tasks, options);
      stopCheck();

      // 8. Execute tasks
      const parallel = this.shouldRunParallel(options);
      const summary = parallel
        ? await this.executeParallel(sprint, tasks, options)
        : await this.executeSequential(sprint, tasks, options);

      // 9. Feedback loop (after all tasks complete, non-session mode)
      if (summary.stopReason === 'all_completed' && !options?.session && !options?.noFeedback) {
        const updatedSprint = await this.persistence.getSprint(sprintId);
        const stopFeedback = log.time('feedback-loop');
        await this.runFeedbackLoop(updatedSprint, options);
        stopFeedback();
      }

      return Result.ok(summary);
    } catch (err) {
      if (err instanceof DomainError) return Result.error(err);
      return Result.error(
        new StorageError(
          `Execution failed: ${err instanceof Error ? err.message : String(err)}`,
          err instanceof Error ? err : undefined
        )
      );
    }
  }

  // -------------------------------------------------------------------------
  // Sprint resolution and preconditions
  // -------------------------------------------------------------------------

  private async resolveAndValidateSprint(sprintId: string): Promise<Sprint> {
    try {
      return await this.persistence.getSprint(sprintId);
    } catch {
      throw new SprintNotFoundError(sprintId);
    }
  }

  private async checkPreconditions(sprint: Sprint): Promise<boolean> {
    // Warn if unrefined tickets
    const unrefinedTickets = sprint.tickets.filter((t) => t.requirementStatus === 'pending');
    if (unrefinedTickets.length > 0) {
      this.logger.warning(
        `Sprint has ${String(unrefinedTickets.length)} unrefined ticket${unrefinedTickets.length !== 1 ? 's' : ''}`
      );
      for (const ticket of unrefinedTickets) {
        this.logger.info(`  ${ticket.id} — ${ticket.title}`);
      }
      const shouldContinue = await this.ui.confirm('Start anyway without refining?', false);
      if (!shouldContinue) {
        this.logger.tip("Run 'sprint refine' first, or use --force to skip this check.");
        return false;
      }
    }

    // Warn if approved tickets have no tasks
    const tasks = await this.persistence.getTasks(sprint.id);
    const ticketIdsWithTasks = new Set(tasks.map((t) => t.ticketId).filter(Boolean));
    const unplannedTickets = sprint.tickets.filter(
      (t) => t.requirementStatus === 'approved' && !ticketIdsWithTasks.has(t.id)
    );

    if (unplannedTickets.length > 0) {
      this.logger.warning('Sprint has refined tickets with no planned tasks:');
      for (const ticket of unplannedTickets) {
        this.logger.info(`  ${ticket.id} — ${ticket.title}`);
      }
      const shouldContinue = await this.ui.confirm('Start anyway without planning?', false);
      if (!shouldContinue) {
        this.logger.tip("Run 'sprint plan' first, or use --force to skip this check.");
        return false;
      }
    }

    return true;
  }

  // -------------------------------------------------------------------------
  // Branch management
  // -------------------------------------------------------------------------

  private async resolveBranchName(sprint: Sprint, options?: ExecutionOptions): Promise<string | null> {
    if (options?.branchName) return options.branchName;
    if (options?.branch) return this.external.generateBranchName(sprint.id);
    if (sprint.branch) return sprint.branch;

    // Interactive prompt
    const autoName = this.external.generateBranchName(sprint.id);
    return this.ui.selectBranchStrategy(sprint.id, autoName);
  }

  private async ensureBranches(sprint: Sprint, tasks: Task[], branchName: string): Promise<void> {
    if (!this.external.isValidBranchName(branchName)) {
      throw new StorageError(`Invalid branch name: ${branchName}`);
    }

    const remainingTasks = tasks.filter((t) => t.status !== 'done');
    const uniquePaths = [...new Set(remainingTasks.map((t) => t.projectPath))];
    if (uniquePaths.length === 0) return;

    // Fail-fast: check for uncommitted changes in all repos
    for (const projectPath of uniquePaths) {
      try {
        if (this.external.hasUncommittedChanges(projectPath)) {
          throw new StorageError(
            `Repository at ${projectPath} has uncommitted changes. Commit or stash them before starting.`
          );
        }
      } catch (err) {
        if (err instanceof StorageError) throw err;
        // Not a git repo — skip silently
      }
    }

    // Create/checkout branch in each repo
    for (const projectPath of uniquePaths) {
      const currentBranch = this.external.getCurrentBranch(projectPath);
      if (currentBranch !== branchName) {
        this.external.createAndCheckoutBranch(projectPath, branchName);
        this.logger.success(`Branch '${branchName}' ready in ${projectPath}`);
      }
    }

    // Persist branch name
    if (sprint.branch !== branchName) {
      const updated = { ...sprint, branch: branchName };
      await this.persistence.saveSprint(updated);
    }

    this.logger.info(`Branch: ${branchName}`);
  }

  // -------------------------------------------------------------------------
  // Check scripts
  // -------------------------------------------------------------------------

  private async runCheckScripts(sprint: Sprint, tasks: Task[], options?: ExecutionOptions): Promise<void> {
    const remainingTasks = tasks.filter((t) => t.status !== 'done');
    const uniquePaths = [...new Set(remainingTasks.map((t) => t.projectPath))];

    for (const projectPath of uniquePaths) {
      // Skip if already ran this sprint (unless refresh forced)
      const previousRun = sprint.checkRanAt[projectPath];
      if (previousRun && !options?.refreshCheck) continue;

      const project = await this.findProjectForPath(sprint, projectPath);
      const checkScript = this.getCheckScript(project, projectPath);
      if (!checkScript) continue;

      this.logger.info(`Running check for ${projectPath}: ${checkScript}`);

      const repo = project?.repositories.find((r) => r.path === projectPath);
      const result = this.external.runCheckScript(projectPath, checkScript, 'sprintStart', repo?.checkTimeout);

      if (!result.passed) {
        throw new StorageError(`Check failed for ${projectPath}: ${checkScript}\n${result.output}`);
      }

      // Record timestamp
      sprint.checkRanAt[projectPath] = new Date().toISOString();
      await this.persistence.saveSprint(sprint);

      this.logger.success(`Check complete: ${projectPath}`);
    }
  }

  // -------------------------------------------------------------------------
  // Task preparation
  // -------------------------------------------------------------------------

  private async prepareTasksOrFail(sprintId: string): Promise<Task[]> {
    await this.persistence.reorderByDependencies(sprintId);
    return this.persistence.getTasks(sprintId);
  }

  // -------------------------------------------------------------------------
  // Sequential execution
  // -------------------------------------------------------------------------

  private async executeSequential(
    sprint: Sprint,
    _allTasks: Task[],
    options?: ExecutionOptions
  ): Promise<ExecutionSummary> {
    // REQ-12 — config is read fresh per task (inside the loop). Kept here only for
    // the initial "is evaluation enabled at all?" precompute; the authoritative
    // value used per iteration lives inside the loop.
    let completedCount = 0;
    const targetCount = options?.count ?? Infinity;

    while (completedCount < targetCount) {
      // Refresh tasks from persistence
      const tasks = await this.persistence.getTasks(sprint.id);
      const readyTask = this.getNextReadyTask(tasks);

      if (!readyTask) {
        const remaining = tasks.filter((t) => t.status !== 'done');
        const blocked = remaining.filter((t) => this.isBlocked(t, tasks));

        if (remaining.length === 0) {
          return {
            completed: completedCount,
            remaining: 0,
            blocked: 0,
            stopReason: completedCount === 0 ? 'no_tasks' : 'all_completed',
            exitCode: completedCount === 0 ? EXIT_NO_TASKS : EXIT_SUCCESS,
          };
        }

        if (blocked.length === remaining.length) {
          return {
            completed: completedCount,
            remaining: remaining.length,
            blocked: blocked.length,
            stopReason: 'all_blocked',
            exitCode: EXIT_ALL_BLOCKED,
          };
        }

        return {
          completed: completedCount,
          remaining: remaining.length,
          blocked: blocked.length,
          stopReason: 'all_completed',
          exitCode: EXIT_SUCCESS,
        };
      }

      this.logger.info(`Task ${String(readyTask.order)}: ${readyTask.name}`, { taskId: readyTask.id });

      // REQ-12: read config fresh per task — evaluationIterations, etc. are
      // editable via the settings panel mid-execution and must take effect
      // from the next task onward.
      const evalCfg = await this.getEvaluationConfig(options);

      // Mark as in_progress
      if (readyTask.status !== 'in_progress') {
        await this.persistence.updateTaskStatus(readyTask.id, 'in_progress', sprint.id);
      }
      this.signalBus.emit({
        type: 'task-started',
        sprintId: sprint.id,
        taskId: readyTask.id,
        taskName: readyTask.name,
        timestamp: new Date(),
      });

      // Branch pre-flight verification
      if (sprint.branch) {
        if (!this.external.verifyBranch(readyTask.projectPath, sprint.branch)) {
          // Attempt auto-recovery
          try {
            this.external.createAndCheckoutBranch(readyTask.projectPath, sprint.branch);
          } catch {
            this.logger.warning(`Branch verification failed: expected '${sprint.branch}' in ${readyTask.projectPath}`);
            const remaining = (await this.persistence.getTasks(sprint.id)).filter((t) => t.status !== 'done');
            return {
              completed: completedCount,
              remaining: remaining.length,
              blocked: 0,
              stopReason: 'task_blocked',
              exitCode: EXIT_ERROR,
            };
          }
        }
      }

      // Execute the task
      const stopTask = this.logger.time('task-execution');
      const result = await this.executeOneTask(readyTask, sprint, options);
      stopTask();

      if (!result.success) {
        this.logger.warning(`Task not completed: ${result.blocked ?? 'Unknown reason'}`);
        const remaining = (await this.persistence.getTasks(sprint.id)).filter((t) => t.status !== 'done');
        return {
          completed: completedCount,
          remaining: remaining.length,
          blocked: 0,
          stopReason: 'task_blocked',
          exitCode: EXIT_ERROR,
        };
      }

      // Store verification result
      if (result.verified) {
        await this.persistence.updateTask(
          readyTask.id,
          { verified: true, verificationOutput: result.verificationOutput },
          sprint.id
        );
        this.logger.success('Verification: passed');
      }

      // Post-task check gate
      const checkPassed = await this.runPostTaskCheck(readyTask, sprint);
      if (!checkPassed) {
        this.logger.warning(`Post-task check failed for: ${readyTask.name}`);
        const remaining = (await this.persistence.getTasks(sprint.id)).filter((t) => t.status !== 'done');
        return {
          completed: completedCount,
          remaining: remaining.length,
          blocked: 0,
          stopReason: 'task_blocked',
          exitCode: EXIT_ERROR,
        };
      }

      // Evaluation loop (if enabled)
      if (evalCfg.enabled) {
        const stopEval = this.logger.time('evaluation');
        await this.evaluator.execute(sprint.id, readyTask.id, {
          iterations: evalCfg.iterations,
          fallbackModel: result.model ?? undefined,
          maxTurns: options?.maxTurns,
        });
        stopEval();
      }

      // Mark as done
      await this.persistence.updateTaskStatus(readyTask.id, 'done', sprint.id);
      this.logger.success('Status updated to: done');
      this.signalBus.emit({
        type: 'task-finished',
        sprintId: sprint.id,
        taskId: readyTask.id,
        status: 'done',
        timestamp: new Date(),
      });

      // Log progress
      await this.persistence.logProgress(`Completed task: ${readyTask.id} - ${readyTask.name}`, {
        sprintId: sprint.id,
        projectPath: readyTask.projectPath,
      });

      completedCount++;

      // Step mode: confirm before continuing
      if (options?.step && completedCount < targetCount) {
        const remaining = (await this.persistence.getTasks(sprint.id)).filter((t) => t.status !== 'done');
        if (remaining.length > 0) {
          this.logger.info(`${String(remaining.length)} task(s) remaining.`);
          const shouldContinue = await this.ui.confirm('Continue to next task?', true);
          if (!shouldContinue) {
            return {
              completed: completedCount,
              remaining: remaining.length,
              blocked: 0,
              stopReason: 'user_paused',
              exitCode: EXIT_SUCCESS,
            };
          }
        }
      }
    }

    // Reached count limit
    const remaining = (await this.persistence.getTasks(sprint.id)).filter((t) => t.status !== 'done');
    return {
      completed: completedCount,
      remaining: remaining.length,
      blocked: 0,
      stopReason: remaining.length === 0 ? 'all_completed' : 'count_reached',
      exitCode: EXIT_SUCCESS,
    };
  }

  // -------------------------------------------------------------------------
  // Parallel mode decision
  // -------------------------------------------------------------------------

  private shouldRunParallel(options?: ExecutionOptions): boolean {
    if (options?.session) return false;
    if (options?.step) return false;
    if (options?.concurrency === 1) return false;
    return (options?.concurrency ?? 0) > 1;
  }

  // -------------------------------------------------------------------------
  // Task picking for parallel execution
  // -------------------------------------------------------------------------

  /**
   * Pick tasks to launch: one per unique projectPath, respecting concurrency limit.
   * Excludes repos that already have an in-flight task or have failed checks.
   */
  private pickTasksToLaunch(
    readyTasks: Task[],
    inFlightPaths: Set<string>,
    concurrencyLimit: number,
    currentInFlight: number,
    failedPaths: Set<string>
  ): Task[] {
    const available = readyTasks.filter((t) => !inFlightPaths.has(t.projectPath) && !failedPaths.has(t.projectPath));

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

  // -------------------------------------------------------------------------
  // Parallel execution
  // -------------------------------------------------------------------------

  private async executeParallel(
    sprint: Sprint,
    allTasks: Task[],
    options?: ExecutionOptions
  ): Promise<ExecutionSummary> {
    // Install signal handlers eagerly so Ctrl+C works before the first child spawns
    ProcessManager.getInstance().ensureHandlers();

    // REQ-12 — config is read fresh per task settlement (see getEvaluationConfig()).
    // No snapshot at execute start.
    let completedCount = 0;
    const targetCount = options?.count ?? Infinity;
    const failFast = options?.failFast ?? true;
    let hasFailed = false;
    let firstBlockedReason: string | null = null;

    // Determine concurrency limit (hard cap prevents resource exhaustion)
    const MAX_CONCURRENCY = 10;
    const uniqueRepoPaths = new Set(allTasks.map((t) => t.projectPath));
    const concurrencyLimit = Math.min(options?.concurrency ?? uniqueRepoPaths.size, MAX_CONCURRENCY);

    this.logger.info(`Parallel mode: up to ${String(concurrencyLimit)} concurrent task(s)`);

    // Set up rate limit coordinator
    const coordinator = new RateLimitCoordinator({
      onPause: (delayMs) => {
        this.logger.warning(`Rate limited. Pausing new launches for ${String(Math.round(delayMs / 1000))}s...`);
        this.signalBus.emit({ type: 'rate-limit-paused', delayMs, timestamp: new Date() });
      },
      onResume: () => {
        this.logger.success('Rate limit cooldown ended. Resuming launches.');
        this.signalBus.emit({ type: 'rate-limit-resumed', timestamp: new Date() });
      },
    });

    // Track in-flight tasks and session IDs for resume
    const inFlightPaths = new Set<string>();
    const running = new Map<string, Promise<ParallelTaskResult>>();
    const taskSessionIds = new Map<string, string>();
    const branchRetries = new Map<string, number>();
    const failedPaths = new Set<string>();
    const MAX_BRANCH_RETRIES = 3;

    try {
      // Check for resumable in_progress tasks
      const inProgressTasks = allTasks.filter((t) => t.status === 'in_progress');
      if (inProgressTasks.length > 0) {
        this.logger.warning(`Resuming ${String(inProgressTasks.length)} in-progress task(s):`);
        for (const t of inProgressTasks) {
          this.logger.info(`  - ${t.id}: ${t.name}`);
        }
      }

      while (completedCount < targetCount) {
        // Break immediately if shutdown is in progress (Ctrl+C)
        if (ProcessManager.getInstance().isShuttingDown()) break;

        // Wait if rate limited before checking for new tasks
        await coordinator.waitIfPaused();

        // Get current task state from disk
        const readyTasks = await this.persistence.getReadyTasks(sprint.id);

        // Also check for in_progress tasks (resumable)
        const currentTasks = await this.persistence.getTasks(sprint.id);
        const inProgress = currentTasks.filter((t) => t.status === 'in_progress' && !running.has(t.id));

        // Combine: resume in_progress first, then ready tasks
        const launchCandidates = [...inProgress, ...readyTasks.filter((t) => !inProgress.some((ip) => ip.id === t.id))];

        if (launchCandidates.length === 0 && running.size === 0) {
          // Nothing to run and nothing in flight
          const remaining = await this.persistence.getRemainingTasks(sprint.id);
          if (remaining.length === 0) {
            if (completedCount === 0) {
              return { completed: 0, remaining: 0, blocked: 0, stopReason: 'no_tasks', exitCode: EXIT_NO_TASKS };
            }
            this.logger.success('All tasks completed!');
            return {
              completed: completedCount,
              remaining: 0,
              blocked: 0,
              stopReason: 'all_completed',
              exitCode: EXIT_SUCCESS,
            };
          }

          // Tasks exist but none are launchable — all blocked
          const hasFailures = hasFailed || failedPaths.size > 0;
          if (failedPaths.size > 0) {
            this.logger.warning(`Repos with failed checks: ${[...failedPaths].join(', ')}`);
          }
          const blocked = remaining.filter((t) => this.isBlocked(t, currentTasks));
          return {
            completed: completedCount,
            remaining: remaining.length,
            blocked: blocked.length,
            stopReason: hasFailures ? 'task_blocked' : 'all_blocked',
            exitCode: hasFailures ? EXIT_ERROR : EXIT_ALL_BLOCKED,
          };
        }

        // Pick tasks to launch (if we should)
        // Per-repo failures don't block other repos — only global hasFailed respects failFast
        if (!hasFailed || !failFast) {
          const toStart = this.pickTasksToLaunch(
            launchCandidates,
            inFlightPaths,
            concurrencyLimit,
            running.size,
            failedPaths
          );

          for (const task of toStart) {
            if (completedCount + running.size >= targetCount) break;

            // Branch verification (if sprint has a branch set)
            if (sprint.branch) {
              if (!this.external.verifyBranch(task.projectPath, sprint.branch)) {
                const attempt = (branchRetries.get(task.id) ?? 0) + 1;
                branchRetries.set(task.id, attempt);

                if (attempt < MAX_BRANCH_RETRIES) {
                  this.logger.warning(
                    `Branch verification failed (attempt ${String(attempt)}/${String(MAX_BRANCH_RETRIES)}): expected '${sprint.branch}' in ${task.projectPath}`
                  );
                  this.logger.info(`Task ${task.id} will retry on next loop iteration.`);
                  continue;
                }

                // Exhausted retries — treat as a real failure
                this.logger.warning(
                  `Branch verification failed after ${String(MAX_BRANCH_RETRIES)} attempts: expected '${sprint.branch}' in ${task.projectPath}`
                );
                this.logger.info(`Task ${task.id} not started — wrong branch.`);
                hasFailed = true;
                firstBlockedReason ??= `Repository ${task.projectPath} is not on expected branch '${sprint.branch}'`;
                if (failFast) {
                  this.logger.info('Fail-fast: waiting for running tasks to finish...');
                }
                continue;
              }
            }

            // Mark as in_progress only after pre-flight passes
            if (task.status !== 'in_progress') {
              await this.persistence.updateTaskStatus(task.id, 'in_progress', sprint.id);
            }
            this.signalBus.emit({
              type: 'task-started',
              sprintId: sprint.id,
              taskId: task.id,
              taskName: task.name,
              timestamp: new Date(),
            });

            const resumeId = taskSessionIds.get(task.id);
            const action = resumeId ? 'Resuming' : 'Starting';

            this.logger.info(`--- ${action} task ${String(task.order)}: ${task.name} ---`);
            this.logger.info(`ID:      ${task.id}`);
            this.logger.info(`Project: ${task.projectPath}`);

            inFlightPaths.add(task.projectPath);

            const taskPromise = this.runParallelTask(task, sprint, options).then(
              (result): ParallelTaskResult => {
                inFlightPaths.delete(task.projectPath);
                return result;
              },
              (error: unknown): ParallelTaskResult => {
                inFlightPaths.delete(task.projectPath);
                const err = error instanceof Error ? error : new Error(String(error));
                if (err instanceof SpawnError && err.rateLimited) {
                  if (err.sessionId) taskSessionIds.set(task.id, err.sessionId);
                  coordinator.pause(err.retryAfterMs ?? 60_000);
                  return { task, result: null, error: err, isRateLimited: true };
                }
                return { task, result: null, error: err, isRateLimited: false };
              }
            );

            running.set(task.id, taskPromise);
          }
        }

        // Wait for any task to complete
        if (running.size === 0) {
          // Check if any tasks are pending branch retry before giving up
          const hasPendingBranchRetry = [...branchRetries.entries()].some(([, count]) => count < MAX_BRANCH_RETRIES);
          if (hasPendingBranchRetry) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
            continue;
          }
          break;
        }

        // Wait for first task to complete
        const settled = await Promise.race([...running.values()]);
        running.delete(settled.task.id);

        // Process the result
        if (settled.error) {
          if (settled.isRateLimited) {
            const sessionId = taskSessionIds.get(settled.task.id);
            this.logger.warning(`Rate limited: ${settled.task.name}`);
            if (sessionId) {
              this.logger.info(`Session saved for resume: ${sessionId.slice(0, 8)}...`);
            }
            this.logger.info('Will retry after cooldown.');
            continue;
          }

          // Real error
          this.logger.warning(`Task failed: ${settled.task.name}`);
          this.logger.warning(`Error: ${settled.error.message}`);
          this.logger.info(`Task ${settled.task.id} remains in_progress for resumption.`);

          hasFailed = true;
          firstBlockedReason ??= settled.error.message;

          if (failFast) {
            this.logger.info('Fail-fast: waiting for running tasks to finish...');
          }
          continue;
        }

        if (settled.result && !settled.result.success) {
          this.logger.warning(`Task not completed: ${settled.task.name}`);
          if (settled.result.blocked) {
            this.logger.warning(`Reason: ${settled.result.blocked}`);
          }
          this.logger.info(`Task ${settled.task.id} remains in_progress.`);

          hasFailed = true;
          firstBlockedReason ??= settled.result.blocked ?? 'Unknown reason';

          if (failFast) {
            this.logger.info('Fail-fast: waiting for running tasks to finish...');
          }
          continue;
        }

        // Task completed successfully
        if (settled.result) {
          // Store verification result
          if (settled.result.verified) {
            await this.persistence.updateTask(
              settled.task.id,
              { verified: true, verificationOutput: settled.result.verificationOutput },
              sprint.id
            );
            this.logger.success(`Verification passed: ${settled.task.name}`);
          }

          // Post-task check hook
          const checkPassed = await this.runPostTaskCheck(settled.task, sprint);
          if (!checkPassed) {
            this.logger.warning(`Post-task check failed for: ${settled.task.name}`);
            this.logger.info(`Task ${settled.task.id} remains in_progress. Repo ${settled.task.projectPath} paused.`);
            failedPaths.add(settled.task.projectPath);
            firstBlockedReason ??= `Post-task check failed in ${settled.task.projectPath}`;
            continue;
          }

          // Evaluation loop (if enabled) — REQ-12: read config fresh per settlement
          const evalCfg = await this.getEvaluationConfig(options);
          if (evalCfg.enabled) {
            await this.evaluator.execute(sprint.id, settled.task.id, {
              iterations: evalCfg.iterations,
              fallbackModel: settled.result.model ?? undefined,
              maxTurns: options?.maxTurns,
            });
          }

          // Mark done
          await this.persistence.updateTaskStatus(settled.task.id, 'done', sprint.id);
          this.logger.success(`Completed: ${settled.task.name}`);
          this.signalBus.emit({
            type: 'task-finished',
            sprintId: sprint.id,
            taskId: settled.task.id,
            status: 'done',
            timestamp: new Date(),
          });

          // Clean up session tracking
          taskSessionIds.delete(settled.task.id);

          // Log progress
          await this.persistence.logProgress(`Completed task: ${settled.task.id} - ${settled.task.name}`, {
            sprintId: sprint.id,
            projectPath: settled.task.projectPath,
          });

          completedCount++;
        }
      }

      // Wait for any remaining in-flight tasks
      if (running.size > 0) {
        this.logger.info(`Waiting for ${String(running.size)} remaining task(s)...`);
        const remaining = await Promise.allSettled([...running.values()]);
        for (const r of remaining) {
          if (r.status === 'fulfilled' && r.value.result?.success) {
            if (r.value.result.verified) {
              await this.persistence.updateTask(
                r.value.task.id,
                { verified: true, verificationOutput: r.value.result.verificationOutput },
                sprint.id
              );
            }
            const checkPassed = await this.runPostTaskCheck(r.value.task, sprint);
            if (!checkPassed) {
              this.logger.warning(`Post-task check failed for: ${r.value.task.name}`);
              continue;
            }

            const evalCfgTail = await this.getEvaluationConfig(options);
            if (evalCfgTail.enabled) {
              await this.evaluator.execute(sprint.id, r.value.task.id, {
                iterations: evalCfgTail.iterations,
                fallbackModel: r.value.result.model ?? undefined,
                maxTurns: options?.maxTurns,
              });
            }

            await this.persistence.updateTaskStatus(r.value.task.id, 'done', sprint.id);
            this.logger.success(`Completed: ${r.value.task.name}`);
            this.signalBus.emit({
              type: 'task-finished',
              sprintId: sprint.id,
              taskId: r.value.task.id,
              status: 'done',
              timestamp: new Date(),
            });
            await this.persistence.logProgress(`Completed task: ${r.value.task.id} - ${r.value.task.name}`, {
              sprintId: sprint.id,
              projectPath: r.value.task.projectPath,
            });
            completedCount++;
          }
        }
      }
    } finally {
      coordinator.dispose();
    }

    const remainingTasks = await this.persistence.getRemainingTasks(sprint.id);
    const allCurrentTasks = await this.persistence.getTasks(sprint.id);
    const blockedCount = remainingTasks.filter((t) => this.isBlocked(t, allCurrentTasks)).length;

    if (hasFailed) {
      return {
        completed: completedCount,
        remaining: remainingTasks.length,
        blocked: blockedCount,
        stopReason: 'task_blocked',
        exitCode: EXIT_ERROR,
      };
    }

    return {
      completed: completedCount,
      remaining: remainingTasks.length,
      blocked: blockedCount,
      stopReason: remainingTasks.length === 0 ? 'all_completed' : 'count_reached',
      exitCode: EXIT_SUCCESS,
    };
  }

  /**
   * Run a single task in parallel mode, returning a result envelope.
   */
  private async runParallelTask(task: Task, sprint: Sprint, options?: ExecutionOptions): Promise<ParallelTaskResult> {
    const result = await this.executeOneTask(task, sprint, options);
    return { task, result, error: null, isRateLimited: false };
  }

  // -------------------------------------------------------------------------
  // Task execution
  // -------------------------------------------------------------------------

  private async executeOneTask(task: Task, sprint: Sprint, options?: ExecutionOptions): Promise<TaskExecutionResult> {
    const taskLog = this.logger.child({ sprintId: sprint.id, taskId: task.id, projectPath: task.projectPath });
    const sprintDir = this.fs.getSprintDir(sprint.id);
    const context = this.buildTaskContext(task);
    const prompt = this.promptBuilder.buildTaskExecutionPrompt(task, sprint, context);

    const args: string[] = ['--add-dir', sprintDir];
    if (options?.maxTurns != null) args.push('--max-turns', String(options.maxTurns));
    if (options?.maxBudgetUsd != null) args.push('--max-budget-usd', String(options.maxBudgetUsd));
    if (options?.fallbackModel) args.push('--fallback-model', options.fallbackModel);

    if (options?.session) {
      try {
        await this.aiSession.spawnInteractive(prompt, {
          cwd: task.projectPath,
          args,
          env: this.aiSession.getSpawnEnv(),
        });
        return { taskId: task.id, success: true, output: '', verified: true };
      } catch (err) {
        return {
          taskId: task.id,
          success: false,
          output: '',
          blocked: err instanceof Error ? err.message : String(err),
        };
      }
    }

    // Headless mode
    const spinner = taskLog.spinner(`${this.aiSession.getProviderDisplayName()} is working on: ${task.name}`);

    try {
      const result = await this.aiSession.spawnWithRetry(prompt, {
        cwd: task.projectPath,
        args,
        env: this.aiSession.getSpawnEnv(),
        maxRetries: options?.maxRetries,
      });

      spinner.succeed(`${this.aiSession.getProviderDisplayName()} completed: ${task.name}`);

      // Dispatch all signals (progress, notes, blocked) through handler
      const ctx: SignalContext = { sprintId: sprint.id, taskId: task.id, projectPath: task.projectPath };
      const allSignals = await this.dispatchSignals(result.output, ctx);

      // Extract lifecycle signals for flow control
      const blockedSignal = allSignals.find((s) => s.type === 'task-blocked');
      const completeSignal = allSignals.find((s) => s.type === 'task-complete');
      const verifiedSignal = allSignals.find((s) => s.type === 'task-verified');

      if (blockedSignal) {
        return {
          taskId: task.id,
          success: false,
          output: result.output,
          blocked: blockedSignal.reason,
          sessionId: result.sessionId,
          model: result.model,
        };
      }

      return {
        taskId: task.id,
        success: completeSignal != null,
        output: result.output,
        verified: verifiedSignal != null,
        verificationOutput: verifiedSignal?.type === 'task-verified' ? verifiedSignal.output : undefined,
        sessionId: result.sessionId,
        model: result.model,
      };
    } catch (err) {
      spinner.fail(`${this.aiSession.getProviderDisplayName()} failed: ${task.name}`);

      if (err instanceof SpawnError && err.rateLimited && err.sessionId) {
        return { taskId: task.id, success: false, output: '', blocked: 'Rate limited', sessionId: err.sessionId };
      }

      return { taskId: task.id, success: false, output: '', blocked: err instanceof Error ? err.message : String(err) };
    }
  }

  // -------------------------------------------------------------------------
  // Post-task check
  // -------------------------------------------------------------------------

  private async runPostTaskCheck(task: Task, sprint: Sprint): Promise<boolean> {
    const project = await this.findProjectForPath(sprint, task.projectPath);
    const checkScript = this.getCheckScript(project, task.projectPath);
    if (!checkScript) return true;

    this.logger.info(`Running post-task check: ${checkScript}`);
    const repo = project?.repositories.find((r) => r.path === task.projectPath);
    const result = this.external.runCheckScript(task.projectPath, checkScript, 'taskComplete', repo?.checkTimeout);

    if (result.passed) {
      this.logger.success('Post-task check: passed');
    }
    return result.passed;
  }

  // -------------------------------------------------------------------------
  // Feedback loop
  // -------------------------------------------------------------------------

  private async runFeedbackLoop(sprint: Sprint, options?: ExecutionOptions): Promise<void> {
    const MAX_FEEDBACK_ITERATIONS = 10;

    for (let iteration = 0; iteration < MAX_FEEDBACK_ITERATIONS; iteration++) {
      const feedback = await this.ui.getFeedback('All tasks complete. Enter feedback for changes (empty to approve):');

      // null/empty = user approves
      if (!feedback) return;

      await this.persistence.logProgress(`User feedback: ${feedback}`, { sprintId: sprint.id });

      const tasks = await this.persistence.getTasks(sprint.id);
      const completedSummary = tasks
        .filter((t) => t.status === 'done')
        .map((t) => `- ${t.name} (${t.projectPath})`)
        .join('\n');

      const projectPaths = [...new Set(tasks.map((t) => t.projectPath))];

      for (const projectPath of projectPaths) {
        const prompt = this.promptBuilder.buildFeedbackPrompt(sprint.name, completedSummary, feedback, sprint.branch);

        this.logger.info(`Implementing feedback in ${projectPath}...`);
        const spinner = this.logger.spinner('AI is implementing feedback...');

        try {
          const sprintDir = this.fs.getSprintDir(sprint.id);
          const result = await this.aiSession.spawnWithRetry(prompt, {
            cwd: projectPath,
            args: ['--add-dir', sprintDir],
            env: this.aiSession.getSpawnEnv(),
            maxTurns: options?.maxTurns,
          });
          spinner.succeed('Feedback implementation completed');

          const signals = this.parser.parseExecutionSignals(result.output);
          if (signals.blocked) {
            this.logger.warning(`Feedback blocked: ${signals.blocked}`);
          }
        } catch (err) {
          spinner.fail('Feedback implementation failed');
          this.logger.warning(err instanceof Error ? err.message : String(err));
        }
      }

      // Run post-feedback check scripts
      for (const projectPath of projectPaths) {
        const project = await this.findProjectForPath(sprint, projectPath);
        const checkScript = this.getCheckScript(project, projectPath);
        if (checkScript) {
          this.logger.info(`Running checks after feedback: ${checkScript}`);
          const repo = project?.repositories.find((r) => r.path === projectPath);
          const result = this.external.runCheckScript(projectPath, checkScript, 'taskComplete', repo?.checkTimeout);
          if (!result.passed) {
            this.logger.warning(`Check failed after feedback in ${projectPath}`);
          } else {
            this.logger.success(`Checks passed: ${projectPath}`);
          }
        }
      }
    }

    this.logger.warning(`Reached maximum feedback iterations (${String(MAX_FEEDBACK_ITERATIONS)}). Proceeding.`);
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private getNextReadyTask(tasks: Task[]): Task | null {
    const inProgress = tasks.find((t) => t.status === 'in_progress');
    if (inProgress) return inProgress;

    const doneTasks = new Set(tasks.filter((t) => t.status === 'done').map((t) => t.id));
    return tasks.find((t) => t.status === 'todo' && t.blockedBy.every((dep) => doneTasks.has(dep))) ?? null;
  }

  private isBlocked(task: Task, allTasks: Task[]): boolean {
    if (task.blockedBy.length === 0) return false;
    const doneTasks = new Set(allTasks.filter((t) => t.status === 'done').map((t) => t.id));
    return task.blockedBy.some((dep) => !doneTasks.has(dep));
  }

  private async findProjectForPath(sprint: Sprint, projectPath: string): Promise<Project | undefined> {
    for (const ticket of sprint.tickets) {
      try {
        const project = await this.persistence.getProject(ticket.projectName);
        if (project.repositories.some((r) => r.path === projectPath)) return project;
      } catch {
        // skip
      }
    }
    return undefined;
  }

  private getCheckScript(project: Project | undefined, projectPath: string): string | null {
    if (!project) return null;
    const repo = project.repositories.find((r) => r.path === projectPath);
    return repo?.checkScript ?? null;
  }

  private buildTaskContext(task: Task): string {
    const sections: string[] = [];

    sections.push(`## Task: ${task.name}`);
    if (task.description) sections.push(task.description);

    if (task.steps.length > 0) {
      sections.push('## Steps');
      sections.push(task.steps.map((s, i) => `${String(i + 1)}. ${s}`).join('\n'));
    }

    if (task.verificationCriteria.length > 0) {
      sections.push('## Verification Criteria');
      sections.push(task.verificationCriteria.map((c) => `- ${c}`).join('\n'));
    }

    sections.push(`## Project Path\n${task.projectPath}`);

    return sections.join('\n\n');
  }

  /**
   * Read evaluator configuration fresh from persistence (REQ-12 — live config).
   * Called once per task settlement so the settings panel's mid-execution edits
   * take effect on the next task without requiring a restart.
   */
  private async getEvaluationConfig(options?: ExecutionOptions): Promise<{ enabled: boolean; iterations: number }> {
    const config = await this.persistence.getConfig();
    const iterations = config.evaluationIterations ?? 1;
    const enabled = iterations > 0 && !options?.noEvaluate && !options?.session;
    return { enabled, iterations };
  }

  /**
   * Parse all signals from AI output and dispatch to the signal handler.
   * Returns the parsed signals for flow control by the caller.
   */
  private async dispatchSignals(output: string, ctx: SignalContext): Promise<HarnessSignal[]> {
    const signals = this.signalParser.parseSignals(output);

    for (const signal of signals) {
      switch (signal.type) {
        case 'progress':
          await this.signalHandler.handleProgress(signal, ctx);
          break;
        case 'evaluation':
          await this.signalHandler.handleEvaluation(signal, ctx);
          break;
        case 'task-complete':
          // Don't handle here — use case manages task lifecycle
          break;
        case 'task-verified':
          // Don't handle here — use case manages verification state
          break;
        case 'task-blocked':
          await this.signalHandler.handleTaskBlocked(signal, ctx);
          break;
        case 'note':
          await this.signalHandler.handleNote(signal, ctx);
          break;
        default: {
          const _exhaustive: never = signal;
          void _exhaustive;
        }
      }
      // Broadcast to live subscribers (TUI dashboard). Independent of the
      // durable handler above — dashboard decides what to render.
      this.signalBus.emit({ type: 'signal', signal, ctx });
    }

    return signals;
  }
}
