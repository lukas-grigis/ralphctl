import type { EvaluationOptions, StepContext } from '@src/domain/context.ts';
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
  /** Populated by `run-evaluator-loop` (or by `check-already-evaluated` when skipping). */
  evaluationSummary?: EvaluationSummary;
}

/**
 * Pipeline-level options — `EvaluationOptions` (passed to the use case) plus
 * the pipeline-only `force` flag read by `check-already-evaluated`.
 */
export type EvaluateOptions = EvaluationOptions & {
  /** When false (default), skip re-evaluation if `task.evaluated === true`. */
  force?: boolean;
};

/** Adapters required to build the evaluate pipeline. */
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
 * Short-circuit when the task is already evaluated and `options.force` is
 * falsy: write a `status: 'skipped'` summary that `run-evaluator-loop`
 * detects and no-ops on. Exposed as a named step (not a pre-hook) so the
 * skip path is visible in `stepResults`.
 */
function checkAlreadyEvaluatedStep(options: EvaluateOptions) {
  return step('check-already-evaluated', (ctx: EvaluateContext): DomainResult<Partial<EvaluateContext>> => {
    const task = ctx.tasks?.[0];
    if (task && task.evaluated && !options.force) {
      const summary: EvaluationSummary = { taskId: task.id, status: 'skipped', iterations: 0 };
      return Result.ok({ evaluationSummary: summary });
    }
    return Result.ok({});
  });
}

/**
 * Delegate the full iteration flow (initial eval + fix attempts + sidecar
 * writes + generator resume) to `EvaluateTaskUseCase.execute()`. No-ops
 * when `check-already-evaluated` wrote a skipped summary.
 */
function runEvaluatorLoopStep(useCase: EvaluateTaskUseCase, options: EvaluateOptions) {
  return step('run-evaluator-loop', async (ctx: EvaluateContext): Promise<DomainResult<Partial<EvaluateContext>>> => {
    if (ctx.evaluationSummary?.status === 'skipped') {
      return Result.ok({});
    }

    const result = await useCase.execute(ctx.sprintId, ctx.taskId, {
      ...options,
      abortSignal: ctx.abortSignal ?? options.abortSignal,
    });
    if (!result.ok) return Result.error(result.error);
    return Result.ok({ evaluationSummary: result.value });
  });
}

/**
 * Build the evaluate pipeline. Happy-path step order:
 *   load-sprint → load-task → check-already-evaluated → run-evaluator-loop
 *
 * Caller passes task-specific fields (fallbackModel, generatorSessionId,
 * iterations) via `options`; pipeline is constructed fresh per task so
 * REQ-12 (live config) is satisfied by re-constructing, not by caching.
 *
 * Initial context must carry `{ sprintId, taskId }`.
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
