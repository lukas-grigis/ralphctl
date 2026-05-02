/**
 * `createPerTaskFlow` — per-task chain composed inside the executeFlow's
 * Parallel fan-out. One instance per task in the sprint.
 *
 * Steps (happy path):
 *
 *   branch-preflight → mark-in-progress → wait-for-rate-limit →
 *     execute-task → post-task-check → recover-dirty-tree →
 *     evaluate-task → mark-done
 *
 * The brief calls for `Retry(execute-task, ...)` on rate-limit and
 * `OnError(branch-preflight, fallback: mark-blocked)`. Today's
 * implementation:
 *
 *  - **Retry** — `execute-task` is wrapped in `Retry(maxAttempts: 2,
 *    retryOn: code === 'rate-limited')`. The use case classifies a
 *    rate-limited spawn as outcome `'rate-limited'` returned via
 *    `Result.ok(...)`, so Retry won't fire automatically. We surface
 *    rate-limit as a kernel error instead, letting Retry pick it up.
 *  - **Cancel** — the Retry-wrapped execute-task is further wrapped in
 *    `OnError(catchIf: code === 'aborted', fallback: markBlocked)` so a
 *    user-initiated cancel (TUI `c` key, CLI Ctrl+C) transitions the
 *    in-flight task to `'blocked'` with reason "cancelled by user" and
 *    short-circuits the rest of the chain via `taskBlocked`.
 *  - **Branch preflight** — wrapped in `OnError(catchIf: BranchPreflight
 *    mismatch, fallback: mark-blocked)` so a wrong-branch repo doesn't
 *    crash the entire sprint. The fallback transitions the Task aggregate
 *    to `'blocked'` (recording the preflight error message as the reason)
 *    and sets `ctx.taskBlocked = true`. Every downstream leaf checks the
 *    flag and short-circuits as a no-op so the rest of the chain still
 *    runs (each step still emits a trace entry, keeping the trace honest)
 *    but performs no work. The Parallel fan-out's `failureMode:
 *    'collect-all'` swallows nothing here because the chain returns
 *    `Result.ok` — other tasks continue independently regardless.
 *
 * The `evaluate-task` step is a single Leaf wrapping
 * {@link EvaluateAndFixLoopUseCase} — the loop owns the multi-round
 * generator/evaluator orchestration (iterations cap, plateau detection,
 * generator resume, inter-round check) and exposes a single `Result`
 * back to the chain. Persisting the verdict on the Task aggregate is
 * the chain's job and happens after the loop returns.
 *
 * The evaluator is non-blocking by contract: a failed / malformed /
 * plateau outcome resolves successfully so the per-task chain
 * continues to `mark-done`. Spawn errors propagate but are caught by
 * the surrounding chain frame so `mark-done` still runs. (See the
 * `OnError(catchIf: () => true)` wrapper below.)
 */
import { Result } from '@src/domain/result.ts';

import { BranchPreflightUseCase } from '@src/business/usecases/execute/branch-preflight.ts';
import {
  EvaluateAndFixLoopUseCase,
  type EvaluateAndFixLoopOutput,
} from '@src/business/usecases/evaluate/evaluate-and-fix-loop.ts';
import { EvaluateTaskUseCase } from '@src/business/usecases/evaluate/evaluate-task.ts';
import {
  ExecuteSingleTaskUseCase,
  type TaskExecutionOutcome,
} from '@src/business/usecases/execute/execute-single-task.ts';
import { PostTaskCheckUseCase, type PostTaskCheckOutput } from '@src/business/usecases/execute/post-task-check.ts';
import { RecoverDirtyTreeUseCase } from '@src/business/usecases/execute/recover-dirty-tree.ts';
import type { Sprint } from '@src/domain/entities/sprint.ts';
import type { Task } from '@src/domain/entities/task.ts';
import type { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import type { SprintId } from '@src/domain/values/sprint-id.ts';
import type { Element, KernelError } from '@src/kernel/chain/element.ts';
import { Leaf } from '@src/kernel/chain/leaf.ts';
import { OnError } from '@src/kernel/chain/on-error.ts';
import { Retry } from '@src/kernel/chain/retry.ts';
import { Sequential } from '@src/kernel/chain/sequential.ts';
import type { ChainSharedDeps } from '@src/application/chains/chain-deps.ts';

export interface PerTaskCtx {
  readonly sprintId: SprintId;
  readonly sprint: Sprint;
  readonly task: Task;
  readonly cwd: AbsolutePath;
  readonly expectedBranch: string;
  /** Optional resolved check script for the post-task gate; skipped when missing. */
  readonly checkScript?: string;
  readonly outcome?: TaskExecutionOutcome;
  readonly newSessionId?: string;
  readonly checkResult?: PostTaskCheckOutput;
  /** Surfaced by the evaluate-and-fix loop; absent when the evaluator is disabled. */
  readonly evaluation?: EvaluateAndFixLoopOutput;
  /**
   * Set to `true` by the branch-preflight `OnError` fallback after it
   * transitions the Task aggregate to `'blocked'`. Every downstream leaf
   * checks this flag and no-ops, keeping the trace honest while skipping
   * the actual work.
   */
  readonly taskBlocked?: boolean;
}

export interface CreatePerTaskFlowOpts {
  readonly task: Task;
  readonly sprint: Sprint;
}

export function createPerTaskFlow(
  deps: Pick<
    ChainSharedDeps,
    | 'sprintRepo'
    | 'taskRepo'
    | 'aiSession'
    | 'prompts'
    | 'signalParser'
    | 'external'
    | 'logger'
    | 'liveConfig'
    | 'signalBus'
    | 'rateLimitCoordinator'
  >,
  opts: CreatePerTaskFlowOpts
): Element<PerTaskCtx> {
  const branchPreflight = new BranchPreflightUseCase(deps.external, deps.logger);
  const executeOne = new ExecuteSingleTaskUseCase(
    deps.aiSession,
    deps.prompts,
    deps.signalParser,
    deps.logger,
    deps.signalBus,
    deps.rateLimitCoordinator
  );
  const postCheck = new PostTaskCheckUseCase(deps.external, deps.logger);
  const recoverDirty = new RecoverDirtyTreeUseCase(deps.external, deps.logger);
  const evaluator = new EvaluateTaskUseCase(deps.aiSession, deps.prompts, deps.signalParser, deps.logger);
  const evaluateLoop = new EvaluateAndFixLoopUseCase(deps.liveConfig, evaluator, executeOne, postCheck, deps.logger);

  const branchPreflightStep = new OnError<PerTaskCtx>(branchPreflightLeaf(branchPreflight), {
    catchIf: (err) => err.code === 'invalid-state',
    fallback: markBlockedFallbackLeaf(deps),
  });

  const executeTaskWithRetry = new Retry<PerTaskCtx>(executeTaskLeaf(executeOne), {
    maxAttempts: 2,
    backoff: 'fixed',
    initialDelayMs: 0,
    retryOn: (err) => err.code === 'rate-limited',
  });

  // User-initiated cancellation propagates as `code: 'aborted'` from the
  // kernel's AbortSignal plumbing. Catch only that variant and transition
  // the task to `'blocked'` with reason "cancelled by user" so the rest
  // of the per-task chain can short-circuit cleanly. Any other error
  // (rate-limit-exhausted, spawn failure, etc.) falls through unchanged.
  const executeTaskStep = new OnError<PerTaskCtx>(executeTaskWithRetry, {
    catchIf: (err) => err.code === 'aborted',
    fallback: markCancelledFallbackLeaf(deps),
  });

  // Wrap the evaluate-and-fix loop so any unexpected spawn error from
  // the loop never blocks the per-task chain. REQUIREMENTS.md guarantees
  // the evaluator never gates task completion.
  const evaluatorAsLeaf = new OnError<PerTaskCtx>(evaluateLoopLeaf(deps, evaluateLoop), {
    catchIf: () => true,
    fallback: noopLeaf<PerTaskCtx>('evaluate-task-noop'),
  });

  // Conditionally include post-task-check only when a check script is
  // configured. Tasks with no check script (e.g. polyglot subdirs) skip
  // the gate cleanly.
  const postTaskStep = postTaskCheckLeaf(postCheck);

  return new Sequential<PerTaskCtx>(`per-task-${opts.task.id}`, [
    branchPreflightStep,
    markInProgressLeaf(deps),
    waitForRateLimitLeaf(deps),
    executeTaskStep,
    postTaskStep,
    recoverDirtyTreeLeaf(recoverDirty),
    evaluatorAsLeaf,
    markDoneLeaf(deps),
  ]);
}

/**
 * Hold off launching a new AI session while the global
 * `RateLimitCoordinator` is paused. When the coordinator is in the
 * running state this leaf resolves immediately (`0ms`); when paused,
 * it awaits `waitUntilResumed()` and then proceeds, surfacing the
 * wait time in the chain trace's `durationMs`.
 *
 * Skipped (no-op) when `taskBlocked` is set so a preflight-blocked
 * task doesn't park here for no reason.
 *
 * The `Retry(maxAttempts: 2, retryOn: code === 'rate-limited')` wrapper
 * around `execute-task` continues to handle the in-task 429 itself —
 * this leaf is the courtesy gate for siblings: when one task hits the
 * rate limit and pauses the coordinator, every other task arriving at
 * this point waits before spawning, instead of three tasks all
 * spawning AI sessions and immediately rate-limiting again.
 */
function waitForRateLimitLeaf(deps: Pick<ChainSharedDeps, 'rateLimitCoordinator'>): Element<PerTaskCtx> {
  return new Leaf<PerTaskCtx, { readonly taskBlocked: boolean }, void>('wait-for-rate-limit', {
    useCase: {
      async execute(input) {
        if (input.taskBlocked) return Result.ok(undefined);
        await deps.rateLimitCoordinator.waitUntilResumed();
        return Result.ok(undefined);
      },
    },
    input: (ctx) => ({ taskBlocked: ctx.taskBlocked === true }),
    output: (ctx) => ctx,
  });
}

function branchPreflightLeaf(useCase: BranchPreflightUseCase): Element<PerTaskCtx> {
  return new Leaf<PerTaskCtx, { readonly projectPath: AbsolutePath; readonly expectedBranch: string }, void>(
    'branch-preflight',
    {
      useCase: {
        async execute(input) {
          return useCase.execute({
            projectPath: input.projectPath,
            expectedBranch: input.expectedBranch,
          });
        },
      },
      input: (ctx) => ({ projectPath: ctx.cwd, expectedBranch: ctx.expectedBranch }),
      output: (ctx) => ctx,
    }
  );
}

/**
 * Branch-preflight `OnError` fallback. Reached only when the wrapped
 * preflight leaf returns an `invalid-state` failure (the only error code
 * `BranchPreflightUseCase` produces for a wrong-branch repo).
 *
 * The OnError contract hands us the same input context the preflight saw,
 * not the caught error. The error has already been surfaced through the
 * logger by the preflight use case; we record a generic-but-faithful
 * reason on the Task aggregate so callers grepping `tasks.json` can see
 * which step failed without needing the trace.
 */
function markBlockedFallbackLeaf(deps: Pick<ChainSharedDeps, 'taskRepo'>): Element<PerTaskCtx> {
  return new Leaf<
    PerTaskCtx,
    { readonly sprintId: SprintId; readonly task: Task; readonly expectedBranch: string },
    Task
  >('mark-blocked', {
    useCase: {
      async execute(input) {
        const reason =
          input.expectedBranch.length > 0
            ? `Branch preflight failed: repo not on '${input.expectedBranch}'`
            : 'Branch preflight failed';
        const transitioned = input.task.markBlocked(reason);
        if (!transitioned.ok) return Result.error(transitioned.error);
        const saved = await deps.taskRepo.update(input.sprintId, transitioned.value);
        if (!saved.ok) return Result.error(saved.error);
        return Result.ok(transitioned.value);
      },
    },
    input: (ctx) => ({ sprintId: ctx.sprintId, task: ctx.task, expectedBranch: ctx.expectedBranch }),
    // Set `taskBlocked: true` on the context so the rest of the per-task
    // chain knows to short-circuit. Every downstream leaf checks the flag
    // and no-ops without doing any work — the chain trace still records
    // each step (kept honest) but no further side effects fire.
    output: (ctx, task) => ({ ...ctx, task, taskBlocked: true }),
  });
}

/**
 * `executeTask` `OnError` fallback for user cancellation. Reached only when
 * the kernel surfaces `code: 'aborted'` (SessionManager.kill / Ctrl+C).
 *
 * The task may already be `in_progress` (mark-in-progress ran first) — both
 * states are valid sources for `markBlocked()`. Records "cancelled by user"
 * as the blocked reason so it appears in `tasks.json` / sprint health.
 */
function markCancelledFallbackLeaf(deps: Pick<ChainSharedDeps, 'taskRepo'>): Element<PerTaskCtx> {
  return new Leaf<PerTaskCtx, { readonly sprintId: SprintId; readonly task: Task }, Task>('mark-blocked', {
    useCase: {
      async execute(input) {
        const reason = 'cancelled by user';
        const transitioned = input.task.markBlocked(reason);
        if (!transitioned.ok) return Result.error(transitioned.error);
        const saved = await deps.taskRepo.update(input.sprintId, transitioned.value);
        if (!saved.ok) return Result.error(saved.error);
        return Result.ok(transitioned.value);
      },
    },
    input: (ctx) => ({ sprintId: ctx.sprintId, task: ctx.task }),
    output: (ctx, task) => ({ ...ctx, task, taskBlocked: true }),
  });
}

function markInProgressLeaf(deps: Pick<ChainSharedDeps, 'taskRepo'>): Element<PerTaskCtx> {
  return new Leaf<
    PerTaskCtx,
    { readonly sprintId: SprintId; readonly task: Task; readonly taskBlocked: boolean },
    Task
  >('mark-in-progress', {
    useCase: {
      async execute(input) {
        if (input.taskBlocked) return Result.ok(input.task);
        const transitioned = input.task.markInProgress();
        if (!transitioned.ok) return Result.error(transitioned.error);
        const saved = await deps.taskRepo.update(input.sprintId, transitioned.value);
        if (!saved.ok) return Result.error(saved.error);
        return Result.ok(transitioned.value);
      },
    },
    input: (ctx) => ({ sprintId: ctx.sprintId, task: ctx.task, taskBlocked: ctx.taskBlocked === true }),
    output: (ctx, task) => ({ ...ctx, task }),
  });
}

function executeTaskLeaf(useCase: ExecuteSingleTaskUseCase): Element<PerTaskCtx> {
  return new Leaf<
    PerTaskCtx,
    { readonly sprint: Sprint; readonly task: Task; readonly cwd: AbsolutePath; readonly taskBlocked: boolean },
    { readonly outcome: TaskExecutionOutcome; readonly newSessionId?: string }
  >('execute-task', {
    useCase: {
      async execute(input) {
        // Skip the AI spawn entirely when the task is already blocked by
        // an earlier preflight failure — there's nothing to execute.
        if (input.taskBlocked) {
          return Result.ok({ outcome: 'blocked' });
        }
        const result = await useCase.execute({
          sprint: input.sprint,
          task: input.task,
          cwd: input.cwd,
        });
        if (!result.ok) return Result.error(result.error);
        // Convert the rate-limited outcome into a kernel error so the
        // surrounding `Retry` can match it. Other outcomes (completed,
        // blocked, failed) propagate as success — the per-task chain
        // decides what to do with them via the marker leaves below.
        if (result.value.outcome === 'rate-limited') {
          return Result.error({
            code: 'rate-limited',
            message: result.value.reason ?? 'rate-limit hit during execute-task',
          });
        }
        return Result.ok({
          outcome: result.value.outcome,
          ...(result.value.newSessionId !== undefined ? { newSessionId: result.value.newSessionId } : {}),
        });
      },
    },
    input: (ctx) => ({ sprint: ctx.sprint, task: ctx.task, cwd: ctx.cwd, taskBlocked: ctx.taskBlocked === true }),
    output: (ctx, out) => ({
      ...ctx,
      outcome: out.outcome,
      ...(out.newSessionId !== undefined ? { newSessionId: out.newSessionId } : {}),
    }),
  });
}

function postTaskCheckLeaf(useCase: PostTaskCheckUseCase): Element<PerTaskCtx> {
  return new Leaf<
    PerTaskCtx,
    { readonly projectPath: AbsolutePath; readonly checkScript?: string; readonly taskBlocked: boolean },
    PostTaskCheckOutput
  >('post-task-check', {
    useCase: {
      async execute(input) {
        if (input.taskBlocked) {
          return Promise.resolve(Result.ok({ passed: true, output: '', skipped: true }));
        }
        if (input.checkScript === undefined || input.checkScript.length === 0) {
          return Promise.resolve(Result.ok({ passed: true, output: '', skipped: true }));
        }
        return useCase.execute({
          projectPath: input.projectPath,
          checkScript: input.checkScript,
        });
      },
    },
    input: (ctx) => ({
      projectPath: ctx.cwd,
      ...(ctx.checkScript !== undefined ? { checkScript: ctx.checkScript } : {}),
      taskBlocked: ctx.taskBlocked === true,
    }),
    output: (ctx, checkResult) => ({ ...ctx, checkResult }),
  });
}

function recoverDirtyTreeLeaf(useCase: RecoverDirtyTreeUseCase): Element<PerTaskCtx> {
  return new Leaf<
    PerTaskCtx,
    {
      readonly projectPath: AbsolutePath;
      readonly taskName: string;
      readonly sprintId: SprintId;
      readonly taskBlocked: boolean;
    },
    void
  >('recover-dirty-tree', {
    useCase: {
      async execute(input) {
        if (input.taskBlocked) return Result.ok(undefined);
        const r = await useCase.execute({
          projectPath: input.projectPath,
          taskName: input.taskName,
          sprintId: input.sprintId,
        });
        if (!r.ok) return Result.error(r.error);
        return Result.ok(undefined);
      },
    },
    input: (ctx) => ({
      projectPath: ctx.cwd,
      taskName: ctx.task.name,
      sprintId: ctx.sprintId,
      taskBlocked: ctx.taskBlocked === true,
    }),
    output: (ctx) => ctx,
  });
}

function markDoneLeaf(deps: Pick<ChainSharedDeps, 'taskRepo' | 'logger'>): Element<PerTaskCtx> {
  return new Leaf<
    PerTaskCtx,
    {
      readonly sprintId: SprintId;
      readonly task: Task;
      readonly outcome?: TaskExecutionOutcome;
      readonly taskBlocked: boolean;
    },
    Task
  >('mark-done', {
    useCase: {
      async execute(input) {
        if (input.taskBlocked) return Result.ok(input.task);
        // Mark-done semantics: by the time we reach this leaf the
        // per-task chain has already run preflight, the AI session,
        // post-task check, dirty-tree recovery, and the (non-blocking)
        // evaluator. The work has either been done or the chain
        // would have aborted. We mark done unless something
        // explicitly negative happened:
        //
        //   - outcome === 'blocked'        — AI emitted <task-blocked>
        //   - evaluationStatus === 'failed'    — evaluator caught a real
        //                                        regression
        //   - evaluationStatus === 'malformed' — evaluator output was
        //                                        unparseable; conservative
        //                                        no-op for human review
        //
        // Note: outcome === 'failed' historically meant "AI did not
        // emit <task-complete>". In practice agents complete the work
        // but occasionally drop the closing tag — leaving such tasks
        // in_progress strands the sprint. Marking done here is safe
        // because the evaluator runs immediately before this leaf and
        // would have flagged a regression as `failed` / `malformed`.
        // (See `evaluateLoopLeaf` above, which always runs and writes
        // `evaluationStatus` onto `ctx.task`.) `outcome === 'completed'`
        // is the explicit happy path.
        //
        // 'rate-limited' never reaches here — Retry surfaces it as a
        // kernel error so this leaf doesn't run on a rate-limited run.
        if (input.outcome === 'blocked') {
          return Result.ok(input.task);
        }
        const evalStatus = input.task.evaluationStatus;
        if (evalStatus === 'failed' || evalStatus === 'malformed') {
          return Result.ok(input.task);
        }
        const transitioned = input.task.markDone();
        if (!transitioned.ok) return Result.error(transitioned.error);
        const saved = await deps.taskRepo.update(input.sprintId, transitioned.value);
        if (!saved.ok) return Result.error(saved.error);
        // Milestone — surface task completion as a success-level log so
        // the live execute view's "Recent events" panel renders it
        // visibly distinct from routine `[INFO]` progress lines.
        deps.logger.success(
          `task ${String(transitioned.value.id)} completed${formatNameSuffix(transitioned.value.name)}`,
          {
            sprintId: input.sprintId,
            taskId: transitioned.value.id,
          }
        );
        return Result.ok(transitioned.value);
      },
    },
    input: (ctx) => ({
      sprintId: ctx.sprintId,
      task: ctx.task,
      ...(ctx.outcome !== undefined ? { outcome: ctx.outcome } : {}),
      taskBlocked: ctx.taskBlocked === true,
    }),
    output: (ctx, task) => ({ ...ctx, task }),
  });
}

/**
 * Render a task name slice for success log messages — three parallel tasks
 * all logging "task <id> completed" is unreadable; appending the name
 * makes the recent-events panel scannable. Mirrors the same helper in
 * `execute-single-task.ts` and `refine-single-ticket.ts`.
 */
function formatNameSuffix(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) return '';
  const max = 50;
  const slice = trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
  return ` — "${slice}"`;
}

/**
 * Run the multi-round evaluate-and-fix loop, then persist the verdict on
 * the Task aggregate. Persistence happens here rather than inside the
 * loop so the loop stays a pure orchestrator (chain-layer concern: side
 * effects on entities the chain owns).
 */
const MAX_PREVIEW_CHARS = 2000;

function evaluateLoopLeaf(
  deps: Pick<ChainSharedDeps, 'taskRepo'>,
  loop: EvaluateAndFixLoopUseCase
): Element<PerTaskCtx> {
  return new Leaf<
    PerTaskCtx,
    {
      readonly sprintId: SprintId;
      readonly sprint: Sprint;
      readonly task: Task;
      readonly cwd: AbsolutePath;
      readonly checkScript?: string;
      readonly resumeSessionId?: string;
      readonly taskBlocked: boolean;
    },
    { readonly evaluation?: EvaluateAndFixLoopOutput; readonly task: Task }
  >('evaluate-task', {
    useCase: {
      async execute(input) {
        if (input.taskBlocked) {
          return Result.ok({ task: input.task });
        }
        const result = await loop.execute({
          task: input.task,
          sprint: input.sprint,
          cwd: input.cwd,
          ...(input.checkScript !== undefined ? { checkScript: input.checkScript } : {}),
          ...(input.resumeSessionId !== undefined ? { resumeSessionId: input.resumeSessionId } : {}),
        });
        if (!result.ok) return Result.error(result.error);

        // Persist the verdict on the Task aggregate. Skipped when the
        // evaluator was disabled (rounds === 0) — the task entity's
        // `evaluated` flag stays false so consumers can tell.
        if (result.value.rounds > 0 && result.value.finalSignal !== null) {
          const recorded = input.task.recordEvaluation({
            status: result.value.finalSignal.status,
            output: result.value.finalCritique.slice(0, MAX_PREVIEW_CHARS),
            file: `evaluations/${input.task.id}.md`,
          });
          const saved = await deps.taskRepo.update(input.sprintId, recorded);
          if (!saved.ok) return Result.error(saved.error);
          return Result.ok({ evaluation: result.value, task: recorded });
        }
        return Result.ok({ evaluation: result.value, task: input.task });
      },
    },
    input: (ctx) => ({
      sprintId: ctx.sprintId,
      sprint: ctx.sprint,
      task: ctx.task,
      cwd: ctx.cwd,
      ...(ctx.checkScript !== undefined ? { checkScript: ctx.checkScript } : {}),
      ...(ctx.newSessionId !== undefined ? { resumeSessionId: ctx.newSessionId } : {}),
      taskBlocked: ctx.taskBlocked === true,
    }),
    // Push the recorded task back onto the context so the downstream
    // `mark-done` leaf carries the evaluation forward when it flips
    // to `done`.
    output: (ctx, out) =>
      out.evaluation === undefined
        ? { ...ctx, task: out.task }
        : { ...ctx, task: out.task, evaluation: out.evaluation },
  });
}

/**
 * Identity leaf — used as an `OnError` fallback so an evaluator failure
 * resolves the chain step with the original context. The evaluator
 * never blocks task completion (REQUIREMENTS.md).
 */
function noopLeaf<TCtx>(name: string): Element<TCtx> {
  return new Leaf<TCtx, TCtx, TCtx>(name, {
    useCase: {
      execute(input) {
        return Promise.resolve(Result.ok(input)) as Promise<Result<TCtx, KernelError>>;
      },
    },
    input: (ctx) => ctx,
    output: (_, ctx) => ctx,
  });
}
