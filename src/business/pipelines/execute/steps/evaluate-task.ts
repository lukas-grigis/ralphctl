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
 * correctly. Inner step names are exposed via
 * `ctx.evaluationStepNames` for assertion, and the full inner
 * records are available during the run for future observability wiring.
 *
 * The evaluator is advisory: if it fails, we log a warning and return
 * `Result.ok`. Per the CLAUDE.md constraint, evaluation must never
 * permanently block a task from marking done.
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
        abortSignal: ctx.abortSignal,
      }
    );

    const innerCtx: EvaluateContext = {
      sprintId: ctx.sprint.id,
      taskId: ctx.task.id,
      generatorModel: ctx.generatorModel ?? null,
      abortSignal: ctx.abortSignal,
    };

    let stepNames: string[] = [];
    try {
      const result = await executePipeline(innerPipeline, innerCtx);
      stepNames = result.ok
        ? result.value.stepResults.map((r) => r.stepName)
        : // Even on failure the framework populates stepResults up to and
          // including the failing step. Extract them opportunistically —
          // if unavailable, proceed with an empty list.
          [];

      if (!result.ok) {
        deps.logger.warning(
          `Evaluation failed for ${ctx.task.name}: ${result.error.message}. Proceeding with task completion.`
        );
      }
    } catch (err) {
      deps.logger.warning(
        `Evaluator threw for ${ctx.task.name}: ${err instanceof Error ? err.message : String(err)}. Proceeding with task completion.`
      );
    }

    const partial: Partial<PerTaskContext> = { evaluationStepNames: stepNames };
    return Result.ok(partial);
  });
}
