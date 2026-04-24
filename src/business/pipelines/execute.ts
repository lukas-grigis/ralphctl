import type { Sprint, Task } from '@src/domain/models.ts';
import type { ExecutionOptions, StepContext } from '@src/domain/context.ts';
import type { DomainResult } from '@src/domain/types.ts';
import { Result } from '@src/domain/types.ts';
import { BranchPreflightError, DomainError, ParseError, SprintStatusError, StorageError } from '@src/domain/errors.ts';
import type { PersistencePort } from '@src/business/ports/persistence.ts';
import type { FilesystemPort } from '@src/business/ports/filesystem.ts';
import type { AiSessionPort } from '@src/business/ports/ai-session.ts';
import type { PromptBuilderPort } from '@src/business/ports/prompt-builder.ts';
import type { OutputParserPort } from '@src/business/ports/output-parser.ts';
import type { UserInteractionPort } from '@src/business/ports/user-interaction.ts';
import type { LoggerPort } from '@src/business/ports/logger.ts';
import type { ExternalPort } from '@src/business/ports/external.ts';
import type { SignalParserPort } from '@src/business/ports/signal-parser.ts';
import type { SignalHandlerPort } from '@src/business/ports/signal-handler.ts';
import type { SignalBusPort } from '@src/business/ports/signal-bus.ts';
import type { RateLimitCoordinatorPort } from '@src/business/ports/rate-limit-coordinator.ts';
import type { ProcessLifecyclePort } from '@src/business/ports/process-lifecycle.ts';
import type { PromptPort } from '@src/business/ports/prompt.ts';
import { findSpawnError, pipeline, step } from '@src/business/pipelines/framework/helpers.ts';
import type { PipelineStep } from '@src/business/pipelines/framework/types.ts';
import { forEachTask, type RetryAction, type SchedulerStats } from '@src/business/pipelines/framework/for-each-task.ts';
import { loadSprintStep } from '@src/business/pipelines/steps/load-sprint.ts';
import { assertSprintStatusStep } from '@src/business/pipelines/steps/assert-sprint-status.ts';
import { runCheckScriptsStep } from '@src/business/pipelines/steps/run-check-scripts.ts';
import { ExecuteTasksUseCase, type ExecutionSummary, type StopReason } from '@src/business/usecases/execute.ts';
import { createPerTaskPipeline } from '@src/business/pipelines/execute/per-task-pipeline.ts';
import type { PerTaskContext } from '@src/business/pipelines/execute/per-task-context.ts';
import { resolveDirtyTree } from '@src/business/pipelines/execute/resolve-dirty-tree.ts';

const EXIT_SUCCESS = 0;
const EXIT_ERROR = 1;
const EXIT_NO_TASKS = 2;
const EXIT_ALL_BLOCKED = 3;
const EXIT_INTERRUPTED = 130;

/** Hard cap on parallel task launches — prevents resource exhaustion. */
const MAX_CONCURRENCY = 10;

/** Number of branch-preflight retries before a task is considered failed. */
const MAX_BRANCH_RETRIES = 3;

/**
 * Context accumulated by the execute pipeline.
 *
 * `proceedAfterPrecondition` — set by `check-preconditions`. When false, all
 *   downstream steps no-op (user declined the "start anyway?" prompt). The
 *   summary is already populated with `stopReason: 'user_paused'`.
 * `tasksEmpty` — set by `prepare-tasks` when the sprint has zero tasks. All
 *   downstream steps (branches, checks, execute) no-op and the
 *   summary is populated with `stopReason: 'no_tasks'`.
 * `branchName` — resolved once up-front by `resolve-branch`. Null means
 *   branch management is disabled for this run.
 * `executionSummary` — terminal output of the pipeline. Populated by exactly
 *   one of: `check-preconditions` (decline), `prepare-tasks` (empty), or
 *   `execute-tasks` (normal completion).
 */
export interface ExecuteContext extends StepContext {
  executionSummary?: ExecutionSummary;
  branchName?: string | null;
  proceedAfterPrecondition?: boolean;
  tasksEmpty?: boolean;
}

/** CLI options threaded into the execute pipeline. Mirrors `ExecutionOptions` exactly. */
export type ExecuteOptions = ExecutionOptions;

/** Adapters required to build the execute pipeline. */
export interface ExecuteDeps {
  persistence: PersistencePort;
  fs: FilesystemPort;
  aiSession: AiSessionPort;
  promptBuilder: PromptBuilderPort;
  parser: OutputParserPort;
  ui: UserInteractionPort;
  logger: LoggerPort;
  external: ExternalPort;
  signalParser: SignalParserPort;
  signalHandler: SignalHandlerPort;
  signalBus: SignalBusPort;
  /**
   * Factory for the parallel scheduler's rate-limit coordinator. Injected
   * so this layer never imports the integration-layer concrete class.
   */
  createRateLimitCoordinator: () => RateLimitCoordinatorPort;
  /** SIGINT/SIGTERM handler installer + shutdown observer. */
  processLifecycle: ProcessLifecyclePort;
  /** Interactive prompt port — used by the dirty-tree resume flow. */
  prompt: PromptPort;
  /** TTY probe — wired from the composition root (integration-layer helper). */
  isTTY: () => boolean;
}

// ---------------------------------------------------------------------------
// Step: check-preconditions
// ---------------------------------------------------------------------------

/**
 * For draft sprints without `--force`, warn about unrefined or unplanned
 * tickets and prompt the user to confirm. On decline, terminate the pipeline
 * cleanly by writing `executionSummary = { ..., stopReason: 'user_paused' }`
 * and clearing `proceedAfterPrecondition`.
 *
 * Mirrors `ExecuteTasksUseCase.checkPreconditions` exactly — same messages,
 * same prompt wording, same tip text on decline.
 */
function checkPreconditionsStep(
  persistence: PersistencePort,
  ui: UserInteractionPort,
  logger: LoggerPort,
  options: ExecuteOptions
): PipelineStep {
  return step<ExecuteContext>('check-preconditions', async (ctx): Promise<DomainResult<Partial<ExecuteContext>>> => {
    const sprint = ctx.sprint;
    if (!sprint) {
      // `load-sprint` guarantees this; guard defensively.
      const partial: Partial<ExecuteContext> = { proceedAfterPrecondition: true };
      return Result.ok(partial);
    }

    // Non-draft sprints or --force skip the precondition check entirely.
    if (sprint.status !== 'draft' || options.force) {
      const partial: Partial<ExecuteContext> = { proceedAfterPrecondition: true };
      return Result.ok(partial);
    }

    // Warn about unrefined tickets
    const unrefinedTickets = sprint.tickets.filter((t) => t.requirementStatus === 'pending');
    if (unrefinedTickets.length > 0) {
      logger.warning(
        `Sprint has ${String(unrefinedTickets.length)} unrefined ticket${unrefinedTickets.length !== 1 ? 's' : ''}`
      );
      for (const ticket of unrefinedTickets) {
        logger.info(`  ${ticket.id} — ${ticket.title}`);
      }
      const shouldContinue = await ui.confirm('Start anyway without refining?', false);
      if (!shouldContinue) {
        logger.tip("Run 'sprint refine' first, or use --force to skip this check.");
        const partial: Partial<ExecuteContext> = {
          proceedAfterPrecondition: false,
          executionSummary: {
            completed: 0,
            remaining: 0,
            blocked: 0,
            stopReason: 'user_paused',
            exitCode: EXIT_SUCCESS,
          },
        };
        return Result.ok(partial);
      }
    }

    // Warn about approved tickets with no tasks
    let tasks: Task[];
    try {
      tasks = await persistence.getTasks(sprint.id);
    } catch (err) {
      if (err instanceof DomainError) return Result.error(err);
      return Result.error(
        new StorageError(err instanceof Error ? err.message : String(err), err instanceof Error ? err : undefined)
      );
    }

    const ticketIdsWithTasks = new Set(tasks.map((t) => t.ticketId).filter(Boolean));
    const unplannedTickets = sprint.tickets.filter(
      (t) => t.requirementStatus === 'approved' && !ticketIdsWithTasks.has(t.id)
    );

    if (unplannedTickets.length > 0) {
      logger.warning('Sprint has refined tickets with no planned tasks:');
      for (const ticket of unplannedTickets) {
        logger.info(`  ${ticket.id} — ${ticket.title}`);
      }
      const shouldContinue = await ui.confirm('Start anyway without planning?', false);
      if (!shouldContinue) {
        logger.tip("Run 'sprint plan' first, or use --force to skip this check.");
        const partial: Partial<ExecuteContext> = {
          proceedAfterPrecondition: false,
          executionSummary: {
            completed: 0,
            remaining: 0,
            blocked: 0,
            stopReason: 'user_paused',
            exitCode: EXIT_SUCCESS,
          },
        };
        return Result.ok(partial);
      }
    }

    const partial: Partial<ExecuteContext> = { proceedAfterPrecondition: true };
    return Result.ok(partial);
  });
}

// ---------------------------------------------------------------------------
// Step: resolve-branch
// ---------------------------------------------------------------------------

/**
 * Resolve branch strategy BEFORE sprint activation so the prompt fires while
 * the sprint is still interactable.
 *
 * Priority (matches `ExecuteTasksUseCase.resolveBranchName`):
 *   1. `--branch-name <name>` — explicit custom name
 *   2. `--branch` — auto-generate from sprint ID
 *   3. `sprint.branch` — already persisted from a prior run
 *   4. Interactive prompt — `selectBranchStrategy` (returns null for "keep current")
 *
 * No-op when `proceedAfterPrecondition` is false — the summary is already
 * set by the previous step.
 */
function resolveBranchStep(external: ExternalPort, ui: UserInteractionPort, options: ExecuteOptions): PipelineStep {
  return step<ExecuteContext>('resolve-branch', async (ctx): Promise<DomainResult<Partial<ExecuteContext>>> => {
    if (ctx.proceedAfterPrecondition === false) {
      const empty: Partial<ExecuteContext> = {};
      return Result.ok(empty);
    }
    const sprint = ctx.sprint;
    if (!sprint) {
      const partial: Partial<ExecuteContext> = { branchName: null };
      return Result.ok(partial);
    }

    let branchName: string | null;
    if (options.branchName) {
      branchName = options.branchName;
    } else if (options.branch) {
      branchName = external.generateBranchName(sprint.id);
    } else if (sprint.branch) {
      branchName = sprint.branch;
    } else {
      const autoName = external.generateBranchName(sprint.id);
      branchName = await ui.selectBranchStrategy(sprint.id, autoName);
    }

    const partial: Partial<ExecuteContext> = { branchName };
    return Result.ok(partial);
  });
}

// ---------------------------------------------------------------------------
// Step: auto-activate
// ---------------------------------------------------------------------------

/**
 * If the sprint is draft, activate it via `persistence.activateSprint` and
 * refresh `ctx.sprint` with the activated instance. Mirrors step 4 of
 * `ExecuteTasksUseCase.execute`.
 */
function autoActivateStep(persistence: PersistencePort): PipelineStep {
  return step<ExecuteContext>('auto-activate', async (ctx): Promise<DomainResult<Partial<ExecuteContext>>> => {
    if (ctx.proceedAfterPrecondition === false) {
      const empty: Partial<ExecuteContext> = {};
      return Result.ok(empty);
    }
    const sprint = ctx.sprint;
    if (sprint?.status !== 'draft') {
      const empty: Partial<ExecuteContext> = {};
      return Result.ok(empty);
    }

    try {
      const activated = await persistence.activateSprint(sprint.id);
      const partial: Partial<ExecuteContext> = { sprint: activated };
      return Result.ok(partial);
    } catch (err) {
      if (err instanceof DomainError) return Result.error(err);
      return Result.error(
        new StorageError(err instanceof Error ? err.message : String(err), err instanceof Error ? err : undefined)
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Step: assert-active (wrapper — skips when preconditions declined)
// ---------------------------------------------------------------------------

/**
 * Wrap the shared `assert-sprint-status` step so the assertion no-ops when
 * the user declined the precondition prompt. A renamed wrapper is needed
 * because the shared step has no context-skip semantics.
 */
function assertActiveStep(): PipelineStep {
  const inner = assertSprintStatusStep<ExecuteContext>(['active'], 'start');
  return step<ExecuteContext>('assert-active', async (ctx): Promise<DomainResult<Partial<ExecuteContext>>> => {
    if (ctx.proceedAfterPrecondition === false) {
      const empty: Partial<ExecuteContext> = {};
      return Result.ok(empty);
    }
    const sprint = ctx.sprint;
    // Emit the same error message the monolithic use case uses so CLI callers
    // see identical text: "Sprint '<name>' is <status>, expected active".
    if (sprint && sprint.status !== 'active') {
      return Result.error(
        new SprintStatusError(`Sprint '${sprint.name}' is ${sprint.status}, expected active`, sprint.status, 'start')
      );
    }
    return inner.execute(ctx);
  });
}

// ---------------------------------------------------------------------------
// Step: prepare-tasks
// ---------------------------------------------------------------------------

/**
 * Reorder by dependencies + load tasks. When the sprint has zero tasks,
 * write an `executionSummary` with `stopReason: 'no_tasks'` and set
 * `tasksEmpty = true` so downstream steps no-op.
 */
function prepareTasksStep(persistence: PersistencePort): PipelineStep {
  return step<ExecuteContext>('prepare-tasks', async (ctx): Promise<DomainResult<Partial<ExecuteContext>>> => {
    if (ctx.proceedAfterPrecondition === false) {
      const empty: Partial<ExecuteContext> = {};
      return Result.ok(empty);
    }

    try {
      await persistence.reorderByDependencies(ctx.sprintId);
      const tasks = await persistence.getTasks(ctx.sprintId);

      if (tasks.length === 0) {
        const partial: Partial<ExecuteContext> = {
          tasks,
          tasksEmpty: true,
          executionSummary: {
            completed: 0,
            remaining: 0,
            blocked: 0,
            stopReason: 'no_tasks',
            exitCode: EXIT_NO_TASKS,
          },
        };
        return Result.ok(partial);
      }

      const partial: Partial<ExecuteContext> = { tasks, tasksEmpty: false };
      return Result.ok(partial);
    } catch (err) {
      if (err instanceof DomainError) return Result.error(err);
      return Result.error(
        new StorageError(err instanceof Error ? err.message : String(err), err instanceof Error ? err : undefined)
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Step: ensure-branches
// ---------------------------------------------------------------------------

/**
 * When `ctx.branchName` is set, validate the name, fail-fast on uncommitted
 * changes, then create/checkout the branch in every repo that has remaining
 * tasks. Persist `sprint.branch` if it changed.
 *
 * No-op when preconditions declined, tasks are empty, or no branch is set.
 * Mirrors `ExecuteTasksUseCase.ensureBranches` exactly — same fail-fast,
 * same per-repo checkout loop, same sprint.branch persistence, same
 * "Branch '<name>' ready" + "Branch: <name>" log lines.
 */
function ensureBranchesStep(
  external: ExternalPort,
  persistence: PersistencePort,
  logger: LoggerPort,
  prompt: PromptPort,
  isTTY: () => boolean,
  options: ExecuteOptions
): PipelineStep {
  return step<ExecuteContext>('ensure-branches', async (ctx): Promise<DomainResult<Partial<ExecuteContext>>> => {
    if (ctx.proceedAfterPrecondition === false || ctx.tasksEmpty) {
      const empty: Partial<ExecuteContext> = {};
      return Result.ok(empty);
    }
    const branchName = ctx.branchName;
    if (!branchName) {
      const empty: Partial<ExecuteContext> = {};
      return Result.ok(empty);
    }

    const sprint = ctx.sprint;
    const tasks = ctx.tasks;
    if (!sprint || !tasks) {
      const empty: Partial<ExecuteContext> = {};
      return Result.ok(empty);
    }

    if (!external.isValidBranchName(branchName)) {
      return Result.error(new StorageError(`Invalid branch name: ${branchName}`));
    }

    const remainingTasks = tasks.filter((t) => t.status !== 'done');
    const uniqueRepoIds = [...new Set(remainingTasks.map((t) => t.repoId))];
    const uniquePaths: string[] = [];
    for (const repoId of uniqueRepoIds) {
      try {
        uniquePaths.push(await persistence.resolveRepoPath(repoId));
      } catch {
        // Unresolvable repoId — skip silently; downstream preflight will fail.
      }
    }
    if (uniquePaths.length === 0) {
      const empty: Partial<ExecuteContext> = {};
      return Result.ok(empty);
    }

    try {
      // Resolve dirty working trees per repo — prompt / reset / abort / block.
      for (const projectPath of uniquePaths) {
        await resolveDirtyTree({
          repoPath: projectPath,
          options,
          prompt,
          isTTY: isTTY(),
          logger,
          external,
        });
      }

      // Create/checkout branch in each repo
      for (const projectPath of uniquePaths) {
        const currentBranch = external.getCurrentBranch(projectPath);
        if (currentBranch !== branchName) {
          external.createAndCheckoutBranch(projectPath, branchName);
          logger.success(`Branch '${branchName}' ready in ${projectPath}`);
        }
      }

      // Persist branch name
      let updatedSprint: Sprint = sprint;
      if (sprint.branch !== branchName) {
        updatedSprint = { ...sprint, branch: branchName };
        await persistence.saveSprint(updatedSprint);
      }

      logger.info(`Branch: ${branchName}`);

      const partial: Partial<ExecuteContext> = { sprint: updatedSprint };
      return Result.ok(partial);
    } catch (err) {
      if (err instanceof DomainError) return Result.error(err);
      return Result.error(
        new StorageError(err instanceof Error ? err.message : String(err), err instanceof Error ? err : undefined)
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Step: sprint-start-check
// ---------------------------------------------------------------------------

/**
 * Wrap the shared `run-check-scripts` step (sprint-start mode) so it no-ops
 * when preconditions declined or tasks are empty. Preserves `log.time`
 * bracketing around the check so timing metrics match today's executor.
 */
function sprintStartCheckStep(
  external: ExternalPort,
  persistence: PersistencePort,
  logger: LoggerPort,
  options: ExecuteOptions
): PipelineStep {
  const inner = runCheckScriptsStep<ExecuteContext>(external, persistence, 'sprint-start', {
    refreshCheck: options.refreshCheck,
  });
  return step<ExecuteContext>('run-check-scripts', async (ctx): Promise<DomainResult<Partial<ExecuteContext>>> => {
    if (ctx.proceedAfterPrecondition === false || ctx.tasksEmpty) {
      const empty: Partial<ExecuteContext> = {};
      return Result.ok(empty);
    }
    // Note: the shared step already matches the monolith's logger.info log line
    // shape. But the monolith wrapped the call in logger.time('check-scripts') —
    // preserve that bracket here so timing metrics don't regress.
    const stopCheck = logger.time('check-scripts');
    try {
      return await inner.execute(ctx);
    } finally {
      stopCheck();
    }
  });
}

// ---------------------------------------------------------------------------
// Step: execute-tasks
// ---------------------------------------------------------------------------

/**
 * Drive sprint execution via `forEachTask` composing the per-task pipeline.
 *
 * Responsibilities (what this step owns):
 *   - Resolve concurrency (session/step modes force sequential).
 *   - Pull launchable tasks on every scheduling tick (in_progress first, then
 *     newly-ready). This preserves `executeParallel`'s resumable behaviour.
 *   - Wire the retry policy: rate-limit → pause-all + requeue, branch
 *     preflight → requeue up to `MAX_BRANCH_RETRIES`, post-task-check fail →
 *     skip-repo, everything else → fail (respecting `failFast`).
 *   - Own the shared `RateLimitCoordinator` + `SignalBus` lifecycle for the
 *     duration of the scheduler run.
 *   - Install `ProcessManager` signal handlers so Ctrl+C works before the
 *     first child spawns.
 *   - Project the scheduler's final `SchedulerStats` into an
 *     `ExecutionSummary` with the correct `stopReason` and `exitCode`.
 *
 * Non-responsibilities (left to other layers):
 *   - Spawning AI sessions, parsing signals, running check scripts — owned by
 *     `ExecuteTasksUseCase.executeOneTask` / `.runPostTaskCheck` (delegated
 *     to by the per-task pipeline steps).
 *   - Mark-in-progress / mark-done / verification persistence — owned by the
 *     per-task pipeline.
 *   - Evaluation — nested pipeline inside the per-task pipeline's
 *     `evaluate-task` step (REQ-12 live config).
 */
function executeTasksStep(deps: ExecuteDeps, options: ExecuteOptions): PipelineStep {
  return step<ExecuteContext>('execute-tasks', async (ctx): Promise<DomainResult<Partial<ExecuteContext>>> => {
    if (ctx.proceedAfterPrecondition === false || ctx.tasksEmpty) {
      const empty: Partial<ExecuteContext> = {};
      return Result.ok(empty);
    }
    const sprint = ctx.sprint;
    if (!sprint) {
      return Result.error(new StorageError('execute-tasks requires ctx.sprint'));
    }
    const allTasks = ctx.tasks;
    if (!allTasks) {
      return Result.error(new StorageError('execute-tasks requires ctx.tasks'));
    }

    // Install signal handlers eagerly so Ctrl+C works before the first child
    // spawns. Idempotent — safe to call on every pipeline invocation.
    deps.processLifecycle.ensureHandlers();

    const useCase = new ExecuteTasksUseCase(
      deps.persistence,
      deps.aiSession,
      deps.promptBuilder,
      deps.parser,
      deps.ui,
      deps.logger,
      deps.external,
      deps.fs,
      deps.signalParser,
      deps.signalHandler,
      deps.signalBus
    );

    // Session IDs captured during rate-limit failures. The map is shared
    // with the per-task pipeline's `execute-task` step, which reads the
    // entry for the current task on each launch and forwards it to
    // `executeOneTask` as `resumeSessionId` — the provider then injects
    // `--resume <id>` / `--resume=<id>` so the AI picks up mid-conversation.
    // Entries are cleared `onSettle` for successful tasks.
    const taskSessionIds = new Map<string, string>();
    // Repos blocked by post-task-check failures or exhausted branch retries.
    const failedRepos = new Set<string>();
    // Tasks this run ever launched. On cancellation we use this to decide
    // which `in_progress` rows to flip to `cancelled` (we never touch tasks
    // this execution didn't start — those may belong to a prior run). Never
    // pruned: the drain step reads persisted `task.status` to decide which
    // are really in_progress, so no stale-state race matters.
    const launchedTaskIds = new Set<string>();
    // First real failure reason — used to populate stopReason when the
    // scheduler surfaces an error.
    let firstBlockedReason: string | null = null;

    // Resolve concurrency: session/step modes force sequential; otherwise cap
    // at the number of unique repo ids or the caller's `--concurrency`.
    const forceSequential = options.session === true || options.step === true;
    const uniqueRepoIds = new Set(allTasks.map((t) => t.repoId));
    const callerConcurrency = options.concurrency ?? uniqueRepoIds.size;
    const resolvedConcurrency = forceSequential ? 1 : Math.min(callerConcurrency, MAX_CONCURRENCY);
    const failFast = options.failFast ?? true;
    const targetCount = options.count ?? Infinity;

    if (!forceSequential) {
      deps.logger.info(`Parallel mode: up to ${String(resolvedConcurrency)} concurrent task(s)`);
    }

    // Announce resumable in-progress tasks up-front — mirrors the executor's
    // behaviour so the log shape doesn't regress.
    const inProgressAtStart = allTasks.filter((t) => t.status === 'in_progress');
    if (inProgressAtStart.length > 0) {
      deps.logger.warning(`Resuming ${String(inProgressAtStart.length)} in-progress task(s):`);
      for (const t of inProgressAtStart) {
        deps.logger.info(`  - ${t.id}: ${t.name}`);
      }
    }

    // Build the per-task pipeline once — it's a pure definition and the
    // scheduler re-runs it for every pulled item.
    const perTaskPipeline = createPerTaskPipeline(
      {
        persistence: deps.persistence,
        fs: deps.fs,
        aiSession: deps.aiSession,
        promptBuilder: deps.promptBuilder,
        parser: deps.parser,
        ui: deps.ui,
        logger: deps.logger,
        external: deps.external,
        signalBus: deps.signalBus,
        taskSessionIds,
      },
      useCase,
      options
    );

    const scheduler = forEachTask<Task, PerTaskContext>({
      // `forEachTask` is generic over the inner-pipeline context, so the
      // per-task steps see `task` / `sprint` directly without casts. The
      // runtime contract: the scheduler injects `task` per-item and the
      // outer pipeline carries `sprint` forward in its context.
      steps: perTaskPipeline,
      itemKey: 'task',
      strategy: {
        concurrency: resolvedConcurrency,
        maxConcurrency: MAX_CONCURRENCY,
        mutexKey: (t) => t.repoId,
        pullItems: async () => {
          // Short-circuit if Ctrl+C fired mid-flight — we want the scheduler
          // to wind down cleanly rather than pick up new work.
          if (deps.processLifecycle.isShuttingDown()) return [];
          const ready = await deps.persistence.getReadyTasks(sprint.id);
          const current = await deps.persistence.getTasks(sprint.id);
          const inProgress = current.filter((t) => t.status === 'in_progress');
          // in_progress first, then ready (minus any already-in-progress to
          // avoid duplicate launches). Matches `executeParallel`'s
          // `launchCandidates` ordering.
          return [...inProgress, ...ready.filter((r) => !inProgress.some((ip) => ip.id === r.id))];
        },
        stopWhen: (stats) => stats.completed >= targetCount,
      },
      policies: {
        retryPolicy: (task, error, attempt): RetryAction => {
          // Rate limit — pause all, requeue this item. Capture sessionId for
          // logging parity with the pre-pipeline executor.
          const spawnErr = findSpawnError(error);
          if (spawnErr?.rateLimited) {
            if (spawnErr.sessionId) taskSessionIds.set(task.id, spawnErr.sessionId);
            deps.logger.warning(`Rate limited: ${task.name}`);
            const recorded = taskSessionIds.get(task.id);
            if (recorded) {
              deps.logger.info(`Session saved for resume: ${recorded.slice(0, 8)}...`);
            }
            deps.logger.info('Will retry after cooldown.');
            return { action: 'pause-all', delayMs: spawnErr.retryAfterMs ?? 60_000, requeueItem: true };
          }

          // Branch preflight failure — requeue up to MAX_BRANCH_RETRIES.
          const branchErr = findBranchPreflightError(error);
          if (branchErr) {
            const count = attempt;
            if (count < MAX_BRANCH_RETRIES) {
              deps.logger.warning(
                `Branch verification failed (attempt ${String(count)}/${String(MAX_BRANCH_RETRIES)}): expected '${branchErr.expectedBranch}' in ${branchErr.projectPath}`
              );
              deps.logger.info(`Task ${task.id} will retry on next loop iteration.`);
              return { action: 'requeue' };
            }
            deps.logger.warning(
              `Branch verification failed after ${String(MAX_BRANCH_RETRIES)} attempts: expected '${branchErr.expectedBranch}' in ${branchErr.projectPath}`
            );
            deps.logger.info(`Task ${task.id} not started — wrong branch.`);
            failedRepos.add(task.repoId);
            firstBlockedReason ??= `Repository ${branchErr.projectPath} is not on expected branch '${branchErr.expectedBranch}'`;
            if (failFast) {
              deps.logger.info('Fail-fast: waiting for running tasks to finish...');
              return { action: 'fail', drainInFlight: true };
            }
            return { action: 'skip-repo', key: task.repoId };
          }

          // Post-task-check failure — block further work in this repo but let
          // sibling repos keep progressing (regardless of failFast: today's
          // executor does the same via `failedPaths`).
          if (isPostTaskCheckFailure(error)) {
            deps.logger.warning(`Post-task check failed for: ${task.name}`);
            deps.logger.info(`Task ${task.id} remains in_progress. Repo ${task.repoId} paused.`);
            failedRepos.add(task.repoId);
            firstBlockedReason ??= `Post-task check failed in ${task.repoId}`;
            return { action: 'skip-repo', key: task.repoId };
          }

          // Task reported `success: false` (not a rate limit / branch issue)
          // — treat as "not completed", leave in_progress for resumption,
          // respect failFast like the pre-pipeline executor.
          if (isTaskNotCompletedFailure(error)) {
            const reason = extractTaskNotCompletedReason(error);
            deps.logger.warning(`Task not completed: ${task.name}`);
            if (reason) deps.logger.warning(`Reason: ${reason}`);
            deps.logger.info(`Task ${task.id} remains in_progress.`);
            firstBlockedReason ??= reason ?? 'Unknown reason';
            if (failFast) {
              deps.logger.info('Fail-fast: waiting for running tasks to finish...');
              return { action: 'fail', drainInFlight: true };
            }
            return { action: 'skip-repo', key: task.repoId };
          }

          // Unexpected failure — spawn error (non-rate-limit), storage error,
          // etc. Log and fail-fast.
          deps.logger.warning(`Task failed: ${task.name}`);
          deps.logger.warning(`Error: ${error.message}`);
          deps.logger.info(`Task ${task.id} remains in_progress for resumption.`);
          firstBlockedReason ??= error.message;
          if (failFast) {
            deps.logger.info('Fail-fast: waiting for running tasks to finish...');
            return { action: 'fail', drainInFlight: true };
          }
          return { action: 'skip-repo', key: task.repoId };
        },
        between: options.step
          ? async (stats): Promise<'continue' | 'stop'> => {
              // Emitted only when there is more work to do (forEachTask
              // probes via hasMoreWork before calling).
              const pendingStr = String(Math.max(0, allTasks.length - stats.completed - stats.failed));
              deps.logger.info(`${pendingStr} task(s) remaining.`);
              const ok = await deps.ui.confirm('Continue to next task?', true);
              return ok ? 'continue' : 'stop';
            }
          : undefined,
        onPause: (delayMs) => {
          // Logger + signal bus parity with the pre-pipeline executor's
          // RateLimitCoordinator onPause callback. The coordinator below is
          // told about the pause by `forEachTask` itself; these callbacks
          // are purely for human-readable output + live dashboard.
          deps.logger.warning(`Rate limited. Pausing new launches for ${String(Math.round(delayMs / 1000))}s...`);
          deps.signalBus.emit({ type: 'rate-limit-paused', delayMs, timestamp: new Date() });
        },
        onResume: () => {
          deps.logger.success('Rate limit cooldown ended. Resuming launches.');
          deps.signalBus.emit({ type: 'rate-limit-resumed', timestamp: new Date() });
        },
        onLaunch: (task) => {
          launchedTaskIds.add(task.id);
          const resumeId = taskSessionIds.get(task.id);
          const action = resumeId ? 'Resuming' : 'Starting';
          deps.logger.info(`--- ${action} task ${String(task.order)}: ${task.name} ---`);
          deps.logger.info(`ID:      ${task.id}`);
          deps.logger.info(`Project: ${task.repoId}`);
        },
        onSettle: (task, result) => {
          if (result === 'success') {
            // Purge session-id tracking — task done. The success log line is
            // owned by the `mark-done` per-task step. We deliberately keep
            // `launchedTaskIds` for the cancellation drain; that set is
            // never consulted on the happy path.
            taskSessionIds.delete(task.id);
          }
        },
      },
      createServices: () => ({
        coordinator: deps.createRateLimitCoordinator(),
        signalBus: deps.signalBus,
      }),
      disposeServices: (services) => {
        // Dispose the coordinator we created but leave the injected signal
        // bus alone — its lifecycle is owned by the outer caller.
        services.coordinator.dispose();
      },
    });

    // Drive the scheduler. It returns `schedulerStats` on settle, or an
    // error if the retryPolicy voted `fail`.
    const schedResult = await scheduler.execute(ctx);

    // Build the summary regardless of ok/error — the scheduler's stats are
    // accurate in both cases, and we need a summary in the ExecuteContext
    // for downstream steps and the feedback loop.
    const emptyStats: SchedulerStats = {
      completed: 0,
      failed: 0,
      requeued: 0,
      inFlight: 0,
      pausedRepos: new Set<string>(),
      cancelled: false,
    };
    const stats: SchedulerStats = schedResult.ok
      ? ((schedResult.value as { schedulerStats?: SchedulerStats }).schedulerStats ?? emptyStats)
      : emptyStats;

    // Cancellation drain: when the scheduler winds down via AbortSignal, any
    // task the per-task pipeline started but didn't finish stays `in_progress`
    // because `mark-done` never ran. Flip those specific rows to `cancelled`
    // and emit matching `task-finished` events so the dashboard sees a
    // terminal state instead of a hung row. We only touch tasks this run
    // launched (`launchedTaskIds`) — never pre-existing `in_progress` rows
    // belonging to a prior session.
    if (stats.cancelled && launchedTaskIds.size > 0) {
      try {
        const currentTasks = await deps.persistence.getTasks(sprint.id);
        const toCancel = currentTasks.filter((t) => launchedTaskIds.has(t.id) && t.status === 'in_progress');
        if (toCancel.length > 0) {
          const updated = currentTasks.map((t) =>
            launchedTaskIds.has(t.id) && t.status === 'in_progress' ? { ...t, status: 'cancelled' as const } : t
          );
          await deps.persistence.saveTasks(updated, sprint.id);
          for (const t of toCancel) {
            deps.signalBus.emit({
              type: 'task-finished',
              sprintId: sprint.id,
              taskId: t.id,
              status: 'cancelled',
              timestamp: new Date(),
            });
          }
          deps.logger.warning(`Cancelled ${String(toCancel.length)} in-progress task(s).`);
        }
      } catch (err) {
        // Drain is best-effort — a write failure here must not mask the real
        // cancellation outcome in the summary.
        deps.logger.warning(
          `Failed to flip in-progress tasks to cancelled: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    const summary = await buildExecutionSummary({
      persistence: deps.persistence,
      sprintId: sprint.id,
      stats,
      targetCount,
      hasFailure: !schedResult.ok || failedRepos.size > 0,
      firstBlockedReason,
      failedRepos,
      logger: deps.logger,
    });

    const partial: Partial<ExecuteContext> = { executionSummary: summary };
    return Result.ok(partial);
  });
}

// ---------------------------------------------------------------------------
// Retry-policy helpers (pure — classify an error's cause chain)
// ---------------------------------------------------------------------------

function findBranchPreflightError(err: DomainError): BranchPreflightError | null {
  let current: Error | undefined = err;
  while (current) {
    if (current instanceof BranchPreflightError) return current;
    current = current instanceof DomainError ? current.cause : undefined;
  }
  return null;
}

/**
 * The `post-task-check` step returns `ParseError` with a message starting
 * with "Post-task check failed" — match on message prefix because the error
 * class is shared with AI-output parsing (introducing a dedicated class
 * would require broader churn without improving safety here).
 */
function isPostTaskCheckFailure(err: DomainError): boolean {
  let current: Error | undefined = err;
  while (current) {
    if (current instanceof ParseError && current.message.startsWith('Post-task check failed')) return true;
    current = current instanceof DomainError ? current.cause : undefined;
  }
  return false;
}

/**
 * The `execute-task` step returns `ParseError('Task not completed: …')` when
 * `executeOneTask` reports `success: false`. That's the non-fatal "task
 * didn't emit <task-complete>" path — callers treat it like a blocker but
 * not a hard failure.
 */
function isTaskNotCompletedFailure(err: DomainError): boolean {
  let current: Error | undefined = err;
  while (current) {
    if (current instanceof ParseError && current.message.startsWith('Task not completed')) return true;
    current = current instanceof DomainError ? current.cause : undefined;
  }
  return false;
}

function extractTaskNotCompletedReason(err: DomainError): string | null {
  let current: Error | undefined = err;
  while (current) {
    if (current instanceof ParseError && current.message.startsWith('Task not completed:')) {
      return current.message.slice('Task not completed:'.length).trim();
    }
    current = current instanceof DomainError ? current.cause : undefined;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Summary builder (projects SchedulerStats + persistence into ExecutionSummary)
// ---------------------------------------------------------------------------

async function buildExecutionSummary(args: {
  persistence: PersistencePort;
  sprintId: string;
  stats: SchedulerStats;
  targetCount: number;
  hasFailure: boolean;
  firstBlockedReason: string | null;
  failedRepos: Set<string>;
  logger: LoggerPort;
}): Promise<ExecutionSummary> {
  const { persistence, sprintId, stats, targetCount, hasFailure, failedRepos, logger } = args;
  const remaining = await persistence.getRemainingTasks(sprintId);
  const currentTasks = await persistence.getTasks(sprintId);
  const blocked = remaining.filter((t) => isBlocked(t, currentTasks));

  // Cancellation takes precedence over every other outcome. The scheduler's
  // `stats.cancelled` flag is set when the outer AbortSignal fired mid-run —
  // the user's explicit "stop" intent must be reflected in `stopReason`
  // rather than folded into `task_blocked` / `user_paused`.
  if (stats.cancelled) {
    return {
      completed: stats.completed,
      remaining: remaining.length,
      blocked: blocked.length,
      stopReason: 'cancelled',
      exitCode: EXIT_INTERRUPTED,
    };
  }

  if (failedRepos.size > 0) {
    logger.warning(`Repos with failed checks: ${[...failedRepos].join(', ')}`);
  }

  if (hasFailure) {
    return {
      completed: stats.completed,
      remaining: remaining.length,
      blocked: blocked.length,
      stopReason: 'task_blocked',
      exitCode: EXIT_ERROR,
    };
  }

  if (remaining.length === 0) {
    if (stats.completed === 0) {
      return {
        completed: 0,
        remaining: 0,
        blocked: 0,
        stopReason: 'no_tasks',
        exitCode: EXIT_NO_TASKS,
      };
    }
    logger.success('All tasks completed!');
    return {
      completed: stats.completed,
      remaining: 0,
      blocked: 0,
      stopReason: 'all_completed',
      exitCode: EXIT_SUCCESS,
    };
  }

  // Remaining tasks but no failure and scheduler stopped — either hit
  // `count` target, user said "stop" at `between` prompt, or every remaining
  // task is blocked by dependencies.
  if (stats.completed >= targetCount) {
    return {
      completed: stats.completed,
      remaining: remaining.length,
      blocked: blocked.length,
      stopReason: 'count_reached',
      exitCode: EXIT_SUCCESS,
    };
  }

  if (blocked.length === remaining.length) {
    return {
      completed: stats.completed,
      remaining: remaining.length,
      blocked: blocked.length,
      stopReason: 'all_blocked',
      exitCode: EXIT_ALL_BLOCKED,
    };
  }

  // Scheduler stopped voluntarily (step-mode "stop") or via stopWhen with
  // slack — report as user_paused so the CLI exit code stays clean.
  const stopReason: StopReason = 'user_paused';
  return {
    completed: stats.completed,
    remaining: remaining.length,
    blocked: blocked.length,
    stopReason,
    exitCode: EXIT_SUCCESS,
  };
}

function isBlocked(task: Task, allTasks: Task[]): boolean {
  if (task.blockedBy.length === 0) return false;
  const doneIds = new Set(allTasks.filter((t) => t.status === 'done').map((t) => t.id));
  return task.blockedBy.some((dep) => !doneIds.has(dep));
}

// ---------------------------------------------------------------------------
// Step: feedback-loop
// ---------------------------------------------------------------------------

/**
 * End-of-sprint feedback loop. Runs ONLY when:
 *   - `executionSummary.stopReason === 'all_completed'`
 *   - `!options.session`
 *   - `!options.noFeedback`
 *
 * Mirrors the guard in `ExecuteTasksUseCase.execute()` exactly. The
 * `MAX_FEEDBACK_ITERATIONS` cap stays inside the use case's method —
 * don't split.
 */
function feedbackLoopStep(deps: ExecuteDeps, options: ExecuteOptions): PipelineStep {
  return step<ExecuteContext>('feedback-loop', async (ctx): Promise<DomainResult<Partial<ExecuteContext>>> => {
    if (ctx.proceedAfterPrecondition === false || ctx.tasksEmpty) {
      const empty: Partial<ExecuteContext> = {};
      return Result.ok(empty);
    }
    const summary = ctx.executionSummary;
    if (!summary) {
      const empty: Partial<ExecuteContext> = {};
      return Result.ok(empty);
    }
    if (summary.stopReason !== 'all_completed' || options.session || options.noFeedback) {
      const empty: Partial<ExecuteContext> = {};
      return Result.ok(empty);
    }

    try {
      const updatedSprint = await deps.persistence.getSprint(ctx.sprintId);
      const useCase = new ExecuteTasksUseCase(
        deps.persistence,
        deps.aiSession,
        deps.promptBuilder,
        deps.parser,
        deps.ui,
        deps.logger,
        deps.external,
        deps.fs,
        deps.signalParser,
        deps.signalHandler,
        deps.signalBus
      );

      const stopFeedback = deps.logger.time('feedback-loop');
      try {
        await useCase.runFeedbackLoopOnly(updatedSprint, options);
      } finally {
        stopFeedback();
      }

      const empty: Partial<ExecuteContext> = {};
      return Result.ok(empty);
    } catch (err) {
      if (err instanceof DomainError) return Result.error(err);
      return Result.error(
        new StorageError(
          `Feedback loop failed: ${err instanceof Error ? err.message : String(err)}`,
          err instanceof Error ? err : undefined
        )
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Pipeline factory
// ---------------------------------------------------------------------------

/**
 * Build the execute pipeline. Happy-path step order (active sprint, with tasks):
 *   load-sprint → check-preconditions → resolve-branch → auto-activate →
 *   assert-active → prepare-tasks → ensure-branches → run-check-scripts →
 *   execute-tasks → feedback-loop
 *
 * Short-circuit paths (all run to completion with no-op downstream steps):
 *   - Draft declined: `check-preconditions` writes user_paused summary; all
 *     downstream steps no-op.
 *   - Zero tasks: `prepare-tasks` writes no_tasks summary; all downstream
 *     steps no-op.
 *
 * Behaviour matches the pre-pipeline `ExecuteTasksUseCase.execute()`
 * exactly. The inner scheduler (`execute-tasks`) now composes `forEachTask`
 * with the per-task pipeline directly; the use case only hosts the task
 * body, check gate, feedback loop, and live evaluation-config read.
 */
export function createExecuteSprintPipeline(deps: ExecuteDeps, options: ExecuteOptions = {}) {
  return pipeline<ExecuteContext>('execute', [
    loadSprintStep<ExecuteContext>(deps.persistence),
    checkPreconditionsStep(deps.persistence, deps.ui, deps.logger, options),
    resolveBranchStep(deps.external, deps.ui, options),
    autoActivateStep(deps.persistence),
    assertActiveStep(),
    prepareTasksStep(deps.persistence),
    ensureBranchesStep(deps.external, deps.persistence, deps.logger, deps.prompt, deps.isTTY, options),
    sprintStartCheckStep(deps.external, deps.persistence, deps.logger, options),
    executeTasksStep(deps, options),
    feedbackLoopStep(deps, options),
  ]);
}
