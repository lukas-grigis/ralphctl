import type { DomainResult } from '@src/domain/types.ts';
import { Result } from '@src/domain/types.ts';
import type { ExecutionOptions } from '@src/domain/context.ts';
import { step } from '@src/business/pipelines/framework/helpers.ts';
import { executePipeline } from '@src/business/pipelines/framework/pipeline.ts';
import type { PipelineStep } from '@src/business/pipelines/framework/types.ts';
import type { LoggerPort } from '@src/business/ports/logger.ts';
import type { ExecuteTasksUseCase } from '@src/business/usecases/execute.ts';
import { createEvaluatorPipeline, type EvaluateContext, type EvaluateDeps } from '@src/business/pipelines/evaluate.ts';
import type { EvaluationSummary } from '@src/business/usecases/evaluate.ts';
import type { PerTaskContext } from '../per-task-context.ts';

interface EvaluateTaskDeps extends EvaluateDeps {
  useCase: ExecuteTasksUseCase;
  options: ExecutionOptions;
}

/**
 * Run the evaluator sub-pipeline (REQ-12 live config via
 * `useCase.getEvaluationConfig`). The evaluator is **advisory** — task
 * always proceeds to `mark-done`; every failure mode (inner error, thrown
 * exception, failed/malformed/plateau critique) logs a warning and
 * returns `Result.ok`. The full critique persists to
 * `evaluations/<taskId>.md` for post-hoc review.
 *
 * We call `executePipeline` directly rather than `nested()` so the outer
 * step can surface `stepResults` on the per-task context for observability.
 */
export function evaluateTask(deps: EvaluateTaskDeps): PipelineStep<PerTaskContext> {
  return step<PerTaskContext>('evaluate-task', async (ctx): Promise<DomainResult<Partial<PerTaskContext>>> => {
    const evalCfg = await deps.useCase.getEvaluationConfig(deps.options);
    if (!evalCfg.enabled) return Result.ok({});

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
        // noCommit (ExecutionOptions) inverted — if the generator committed
        // the initial work, the fix must commit too.
        needsCommit: !deps.options.noCommit,
        // Model ladder input: evaluator uses a cheaper model than the
        // generator's. Null when the generator didn't report one (Copilot,
        // blocked tasks).
        fallbackModel: ctx.generatorModel ?? undefined,
        // --resume <id> so the fix continues the generator's session
        // rather than cold-starting. Undefined → fresh spawn (rare fallback).
        generatorSessionId: ctx.executionResult?.sessionId,
        abortSignal: ctx.abortSignal,
      }
    );

    const innerCtx: EvaluateContext = {
      sprintId: ctx.sprint.id,
      taskId: ctx.task.id,
      abortSignal: ctx.abortSignal,
    };

    try {
      const innerResult = await executePipeline(innerPipeline, innerCtx);
      if (!innerResult.ok) {
        deps.logger.warning(
          `Evaluator pipeline errored for ${ctx.task.name}: ${innerResult.error.message} — proceeding with task completion`
        );
        return Result.ok({ evaluationStepNames: [] });
      }
      logIfNonTerminal(deps.logger, ctx.task.name, innerResult.value.context.evaluationSummary);
      return Result.ok({
        evaluationStepNames: innerResult.value.stepResults.map((r) => r.stepName),
      });
    } catch (err) {
      deps.logger.warning(
        `Evaluator threw for ${ctx.task.name}: ${err instanceof Error ? err.message : String(err)} — proceeding with task completion`
      );
      return Result.ok({ evaluationStepNames: [] });
    }
  });
}

function logIfNonTerminal(logger: LoggerPort, taskName: string, summary: EvaluationSummary | undefined): void {
  if (!summary) return;
  if (summary.status === 'failed' || summary.status === 'malformed' || summary.status === 'plateau') {
    logger.warning(
      `Evaluation ${summary.status} for ${taskName} after ${String(summary.iterations)} iteration(s) — proceeding with task completion`
    );
  }
}
