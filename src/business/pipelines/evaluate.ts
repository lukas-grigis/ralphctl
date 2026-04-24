import type { StepContext } from '@src/domain/context.ts';
import type { DomainResult } from '@src/domain/types.ts';
import { Result } from '@src/domain/types.ts';
import { TaskNotFoundError } from '@src/domain/errors.ts';
import type { PersistencePort } from '@src/business/ports/persistence.ts';
import type { FilesystemPort } from '@src/business/ports/filesystem.ts';
import type { AiSessionPort } from '@src/business/ports/ai-session.ts';
import type { PromptBuilderPort } from '@src/business/ports/prompt-builder.ts';
import type { OutputParserPort } from '@src/business/ports/output-parser.ts';
import type { UserInteractionPort } from '@src/business/ports/user-interaction.ts';
import type { LoggerPort } from '@src/business/ports/logger.ts';
import type { ExternalPort } from '@src/business/ports/external.ts';
import { pipeline, step } from '@src/business/pipelines/framework/helpers.ts';
import { loadSprintStep } from '@src/business/pipelines/steps/load-sprint.ts';
import { EvaluateTaskUseCase, type EvaluationSummary } from '@src/business/usecases/evaluate.ts';

/** Context accumulated by the evaluate pipeline. */
export interface EvaluateContext extends StepContext {
  /** Task being evaluated. Seeded via initial context by the caller. */
  taskId: string;
  /** Generator's model (used by the evaluator's model ladder). Seeded by caller; may be null. */
  generatorModel?: string | null;
  /**
   * Generator's initial session ID. Seeded by the caller (the per-task
   * pipeline's `evaluate-task` step reads it from the preceding
   * `execute-task` result). Threaded into the fix-loop spawn so the fix
   * runs as a continuation of the original task session — see
   * `EvaluationOptions.generatorSessionId` for the full rationale.
   */
  generatorSessionId?: string;
  /** Populated by `run-evaluator-loop` (or by `check-already-evaluated` when skipping). */
  evaluationSummary?: EvaluationSummary;
}

/** Pipeline-level options for the evaluator. */
interface EvaluateOptions {
  /** Max fix attempts after the initial evaluation. Threaded into the use case. */
  iterations?: number;
  /** When false (default), skip re-evaluation if `task.evaluated === true`. */
  force?: boolean;
  /** Max agentic turns for evaluator sessions — passed through to the use case. */
  maxTurns?: number;
  /**
   * Whether the fix attempt should commit before signaling completion.
   * Mirrors the inverse of `ExecutionOptions.noCommit`, threaded by the
   * `evaluate-task` step so the resume prompt matches the task-execution
   * prompt's commit contract.
   */
  needsCommit?: boolean;
  /**
   * Cooperative cancellation. When aborted mid-evaluation, spawned evaluator /
   * fix-loop children receive SIGTERM so a cancelled execution doesn't leak
   * an in-flight evaluator subprocess.
   */
  abortSignal?: AbortSignal;
}

/**
 * Adapters required to build the evaluate pipeline.
 *
 * `external` is used for `detectProjectTooling()` (subagents / skills / MCP
 * servers), rendered into the evaluator prompt. The evaluator doesn't need
 * git/gh, but the Project Tooling section is the same machinery as the
 * planner's, so we share the adapter.
 */
export interface EvaluateDeps {
  persistence: PersistencePort;
  fs: FilesystemPort;
  aiSession: AiSessionPort;
  promptBuilder: PromptBuilderPort;
  parser: OutputParserPort;
  ui: UserInteractionPort;
  logger: LoggerPort;
  external: ExternalPort;
}

/**
 * Load the target task fresh from persistence and stash it on `ctx.tasks`
 * as a single-element array. Reading fresh (not from `ctx.sprint`) ensures
 * the `evaluated` / `evaluationStatus` fields are current — the sprint
 * blob on context may be stale if prior tasks in the same sprint have
 * already mutated task state.
 *
 * Returns `TaskNotFoundError` on any persistence failure — mirrors the
 * pre-pipeline use case's `loadTask` wrapper.
 */
function loadTaskStep(persistence: PersistencePort) {
  return step('load-task', async (ctx: EvaluateContext): Promise<DomainResult<Partial<EvaluateContext>>> => {
    try {
      const task = await persistence.getTask(ctx.taskId, ctx.sprintId);
      const partial: Partial<EvaluateContext> = { tasks: [task] };
      return Result.ok(partial);
    } catch {
      return Result.error(new TaskNotFoundError(ctx.taskId));
    }
  });
}

/**
 * Guard: if the task is already evaluated and `options.force` is falsy,
 * short-circuit the pipeline by writing a `status: 'skipped'` summary. The
 * downstream `run-evaluator-loop` step detects this and no-ops.
 *
 * Exposed as a named step (not a pre-hook on step 4) so the skip path is
 * visible in `StepExecutionRecord[]` — aligns with the principle that
 * major phases are named steps.
 */
function checkAlreadyEvaluatedStep(options: EvaluateOptions) {
  return step('check-already-evaluated', (ctx: EvaluateContext): DomainResult<Partial<EvaluateContext>> => {
    const task = ctx.tasks?.[0];
    if (!task) {
      // `load-task` always writes a single-element tasks array; if missing,
      // the earlier step's contract is broken. Fall through — the next
      // step will surface a real error when it tries to read the task.
      const empty: Partial<EvaluateContext> = {};
      return Result.ok(empty);
    }

    if (task.evaluated && !options.force) {
      const summary: EvaluationSummary = {
        taskId: task.id,
        status: 'skipped',
        iterations: 0,
      };
      const partial: Partial<EvaluateContext> = { evaluationSummary: summary };
      return Result.ok(partial);
    }

    const empty: Partial<EvaluateContext> = {};
    return Result.ok(empty);
  });
}

/**
 * Run-evaluator-loop step: delegates the full iteration flow (initial
 * evaluation + fix attempts + sidecar writes + `tasks.json` preview +
 * generator resume) to `EvaluateTaskUseCase.execute()`.
 *
 * This is the big one — the iteration loop is tightly interleaved with
 * persistence writes (each iteration appends to the sidecar) so extracting
 * it further would require gutting the use case. A future pass can split
 * the loop once the persistence coupling is loosened.
 *
 * Skipped when `check-already-evaluated` wrote a `status: 'skipped'`
 * summary — the skip check lives inline (not a pre-hook) so the step
 * still records as success in the pipeline trace.
 */
function runEvaluatorLoopStep(useCase: EvaluateTaskUseCase, options: EvaluateOptions) {
  return step('run-evaluator-loop', async (ctx: EvaluateContext): Promise<DomainResult<Partial<EvaluateContext>>> => {
    if (ctx.evaluationSummary?.status === 'skipped') {
      // `check-already-evaluated` short-circuited us — leave the summary
      // in place and record this step as a no-op success.
      const empty: Partial<EvaluateContext> = {};
      return Result.ok(empty);
    }

    const result = await useCase.execute(ctx.sprintId, ctx.taskId, {
      iterations: options.iterations,
      maxTurns: options.maxTurns,
      fallbackModel: ctx.generatorModel ?? undefined,
      generatorSessionId: ctx.generatorSessionId,
      needsCommit: options.needsCommit,
      abortSignal: ctx.abortSignal ?? options.abortSignal,
    });
    if (!result.ok) {
      return Result.error(result.error);
    }
    const partial: Partial<EvaluateContext> = { evaluationSummary: result.value };
    return Result.ok(partial);
  });
}

/**
 * Build the evaluate pipeline. Happy-path step order:
 *   load-sprint → load-task → check-already-evaluated → run-evaluator-loop
 *
 * Behavior matches `EvaluateTaskUseCase.execute()` exactly: same model
 * ladder, same iteration semantics, same sidecar writes, same
 * passed/failed/malformed discrimination. The only new semantics is the
 * `check-already-evaluated` guard (skip re-eval when `task.evaluated` and
 * `!force`) — the pre-pipeline use case always re-evaluated unconditionally.
 *
 * `evaluationIterations` is read live by the caller (the Execute pipeline's
 * `resolve-eval-config` step — next phase) and threaded in via
 * `options.iterations`. This pipeline is constructed fresh per task, so
 * REQ-12 (mid-execution settings changes take effect on the next task) is
 * satisfied without additional live-read machinery here.
 *
 * Initial context must carry `{ sprintId, taskId, generatorModel? }`.
 */
export function createEvaluatorPipeline(deps: EvaluateDeps, options: EvaluateOptions = {}) {
  const useCase = new EvaluateTaskUseCase(
    deps.persistence,
    deps.aiSession,
    deps.promptBuilder,
    deps.parser,
    deps.ui,
    deps.logger,
    deps.fs,
    deps.external
  );

  return pipeline<EvaluateContext>('evaluate', [
    loadSprintStep<EvaluateContext>(deps.persistence),
    loadTaskStep(deps.persistence),
    checkAlreadyEvaluatedStep(options),
    runEvaluatorLoopStep(useCase, options),
  ]);
}
