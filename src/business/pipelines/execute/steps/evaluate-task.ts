import type { DomainResult } from '@src/domain/types.ts';
import { Result } from '@src/domain/types.ts';
import type { ExecutionOptions } from '@src/domain/context.ts';
import { step } from '@src/business/pipelines/framework/helpers.ts';
import { executePipeline } from '@src/business/pipelines/framework/pipeline.ts';
import type { PipelineStep } from '@src/business/pipelines/framework/types.ts';
import type { ExecuteTasksUseCase } from '@src/business/usecases/execute.ts';
import { createEvaluatorPipeline, type EvaluateContext, type EvaluateDeps } from '@src/business/pipelines/evaluate.ts';
import type { PerTaskContext } from '../per-task-context.ts';

/**
 * Deps for the evaluate-task step — the evaluator's full adapter graph
 * plus the parent use case (for the live-config read) and the current
 * `ExecutionOptions`.
 */
interface EvaluateTaskDeps extends EvaluateDeps {
  useCase: ExecuteTasksUseCase;
  options: ExecutionOptions;
}

/**
 * Run the evaluator sub-pipeline, if evaluation is enabled.
 *
 * REQ-12 — `evaluationIterations` is read fresh from persistence on every
 * call via `useCase.getEvaluationConfig(options)`. Nothing is cached; a
 * settings-panel edit during execution takes effect on the very next
 * task.
 *
 * The evaluator pipeline is composed via `createEvaluatorPipeline` and
 * run directly with `executePipeline`. We prefer this over wrapping in
 * `nested()` because the nested helper discards the inner `stepResults`
 * — the integration test needs them to verify the evaluator composed
 * correctly. Inner step names are exposed via `ctx.evaluationStepNames`
 * for assertion, and the full inner records are available during the run
 * for future observability wiring.
 *
 * Failure semantics — the evaluator is **advisory** — task always proceeds
 * to `mark-done`; sprint continues with other tasks:
 *
 *   - `status: 'passed' | 'skipped' | 'failed' | 'malformed' | 'plateau'`
 *     → `Result.ok`, pipeline continues to `recover-dirty-tree` +
 *     `mark-done`. Failed outcomes are logged as warnings; the full
 *     critique persists to the evaluation sidecar so the user can review
 *     after the sprint completes.
 *   - Inner pipeline errored / threw → same thing: log a warning and
 *     return `Result.ok`. An evaluator that can't even run is not a
 *     reason to stall the sprint — the executor's own check gate
 *     already guards correctness at the computational level, and the
 *     user can always inspect `evaluations/<taskId>.md` (or its
 *     absence) after the fact.
 *   - `evalCfg.enabled === false` → clean no-op.
 *
 * In every non-pass case the step still surfaces `evaluationStepNames`
 * when it can (the inner pipeline populates `stepResults` up to the
 * failing step), so dashboard observability stays intact.
 */
export function evaluateTask(deps: EvaluateTaskDeps): PipelineStep<PerTaskContext> {
  return step<PerTaskContext>('evaluate-task', async (ctx): Promise<DomainResult<Partial<PerTaskContext>>> => {
    // REQ-12 — read fresh per task settlement. Never cache.
    const evalCfg = await deps.useCase.getEvaluationConfig(deps.options);
    if (!evalCfg.enabled) {
      const empty: Partial<PerTaskContext> = {};
      return Result.ok(empty);
    }

    const innerPipeline = createEvaluatorPipeline(
      {
        persistence: deps.persistence,
        fs: deps.fs,
        aiSession: deps.aiSession,
        promptBuilder: deps.promptBuilder,
        parser: deps.parser,
        ui: deps.ui,
        logger: deps.logger,
        external: deps.external,
      },
      {
        iterations: evalCfg.iterations,
        maxTurns: deps.options.maxTurns,
        // Fix-attempt commit contract mirrors the task-execution contract:
        // if the generator was told to commit its initial work, it must also
        // commit the fix. `noCommit` is the inverted flag on ExecutionOptions
        // (default false -> needsCommit true).
        needsCommit: !deps.options.noCommit,
        abortSignal: ctx.abortSignal,
      }
    );

    const innerCtx: EvaluateContext = {
      sprintId: ctx.sprint.id,
      taskId: ctx.task.id,
      generatorModel: ctx.generatorModel ?? null,
      // Thread the initial generator's session ID so the fix attempt resumes
      // the same conversation (--resume <id>) rather than cold-starting. The
      // `execute-task` step populates `executionResult.sessionId`; undefined
      // here means the initial spawn never returned an ID (rare fallback —
      // e.g., a blocked task) and the use case degrades to a fresh spawn.
      generatorSessionId: ctx.executionResult?.sessionId,
      abortSignal: ctx.abortSignal,
    };

    let stepNames: string[] = [];
    try {
      const innerResult = await executePipeline(innerPipeline, innerCtx);
      // Even on failure the framework populates stepResults up to and
      // including the failing step. Extract them opportunistically so
      // the integration test / dashboard observability still sees what
      // ran.
      stepNames = innerResult.ok ? innerResult.value.stepResults.map((r) => r.stepName) : [];

      if (!innerResult.ok) {
        // Inner pipeline errored (spawn failure, persistence failure, etc.).
        // Non-blocking: the sprint continues. A missing evaluator run is
        // worth a warning, not a full stop — the user can dig into
        // `evaluations/<taskId>.md` (or its absence) after the sprint.
        deps.logger.warning(
          `Evaluator pipeline errored for ${ctx.task.name}: ${innerResult.error.message} — proceeding with task completion`
        );
      } else {
        const summary = innerResult.value.context.evaluationSummary;
        if (
          summary &&
          (summary.status === 'failed' || summary.status === 'malformed' || summary.status === 'plateau')
        ) {
          // Non-blocking: log the outcome and let the task proceed to
          // `mark-done`. The full critique is already persisted in the
          // sidecar; no point duplicating it in the log stream.
          deps.logger.warning(
            `Evaluation ${summary.status} for ${ctx.task.name} after ${String(summary.iterations)} iteration(s) — proceeding with task completion`
          );
        }
      }
    } catch (err) {
      // A thrown exception (outside the Result contract) is likewise
      // non-blocking — matches the pre-blocking behaviour. Log and
      // continue so a misbehaving evaluator never stalls a sprint.
      deps.logger.warning(
        `Evaluator threw for ${ctx.task.name}: ${err instanceof Error ? err.message : String(err)} — proceeding with task completion`
      );
    }

    const partial: Partial<PerTaskContext> = { evaluationStepNames: stepNames };
    return Result.ok(partial);
  });
}
