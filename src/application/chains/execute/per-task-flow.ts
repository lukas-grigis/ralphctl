/**
 * `createPerTaskFlow` — per-task chain composed inside the executeFlow's
 * Parallel fan-out. One instance per task in the sprint.
 *
 * Steps (happy path):
 *
 *   branch-preflight → mark-in-progress → execute-task →
 *     post-task-check → recover-dirty-tree → evaluate-task →
 *     mark-done
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
import { Result } from 'typescript-result';

import { BranchPreflightUseCase } from '../../../business/usecases/execute/branch-preflight.ts';
import {
  EvaluateAndFixLoopUseCase,
  type EvaluateAndFixLoopOutput,
} from '../../../business/usecases/evaluate/evaluate-and-fix-loop.ts';
import { EvaluateTaskUseCase } from '../../../business/usecases/evaluate/evaluate-task.ts';
import {
  ExecuteSingleTaskUseCase,
  type TaskExecutionOutcome,
} from '../../../business/usecases/execute/execute-single-task.ts';
import { PostTaskCheckUseCase, type PostTaskCheckOutput } from '../../../business/usecases/execute/post-task-check.ts';
import { RecoverDirtyTreeUseCase } from '../../../business/usecases/execute/recover-dirty-tree.ts';
import type { Sprint } from '../../../domain/entities/sprint.ts';
import type { Task } from '../../../domain/entities/task.ts';
import type { AbsolutePath } from '../../../domain/values/absolute-path.ts';
import type { SprintId } from '../../../domain/values/sprint-id.ts';
import type { Element, KernelError } from '../../../kernel/chain/element.ts';
import { Leaf } from '../../../kernel/chain/leaf.ts';
import { OnError } from '../../../kernel/chain/on-error.ts';
import { Retry } from '../../../kernel/chain/retry.ts';
import { Sequential } from '../../../kernel/chain/sequential.ts';
import type { ChainSharedDeps } from '../chain-deps.ts';

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
    'sprintRepo' | 'taskRepo' | 'aiSession' | 'prompts' | 'signalParser' | 'external' | 'logger' | 'liveConfig'
  >,
  opts: CreatePerTaskFlowOpts
): Element<PerTaskCtx> {
  const branchPreflight = new BranchPreflightUseCase(deps.external, deps.logger);
  const executeOne = new ExecuteSingleTaskUseCase(deps.aiSession, deps.prompts, deps.signalParser, deps.logger);
  const postCheck = new PostTaskCheckUseCase(deps.external, deps.logger);
  const recoverDirty = new RecoverDirtyTreeUseCase(deps.external, deps.logger);
  const evaluator = new EvaluateTaskUseCase(deps.aiSession, deps.prompts, deps.signalParser, deps.logger);
  const evaluateLoop = new EvaluateAndFixLoopUseCase(deps.liveConfig, evaluator, executeOne, postCheck, deps.logger);

  const branchPreflightStep = new OnError<PerTaskCtx>(branchPreflightLeaf(branchPreflight), {
    catchIf: (err) => err.code === 'invalid-state',
    fallback: markBlockedFallbackLeaf(deps),
  });

  const executeTaskStep = new Retry<PerTaskCtx>(executeTaskLeaf(executeOne), {
    maxAttempts: 2,
    backoff: 'fixed',
    initialDelayMs: 0,
    retryOn: (err) => err.code === 'rate-limited',
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
    executeTaskStep,
    postTaskStep,
    recoverDirtyTreeLeaf(recoverDirty),
    evaluatorAsLeaf,
    markDoneLeaf(deps),
  ]);
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

function markDoneLeaf(deps: Pick<ChainSharedDeps, 'taskRepo'>): Element<PerTaskCtx> {
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
        // Only flip to done when the task actually completed. Blocked /
        // failed outcomes leave the task in 'in_progress' for the
        // sprint health view to surface.
        if (input.outcome !== 'completed') {
          return Result.ok(input.task);
        }
        const transitioned = input.task.markDone();
        if (!transitioned.ok) return Result.error(transitioned.error);
        const saved = await deps.taskRepo.update(input.sprintId, transitioned.value);
        if (!saved.ok) return Result.error(saved.error);
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
