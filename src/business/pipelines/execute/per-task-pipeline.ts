import type { ExecutionOptions } from '@src/domain/context.ts';
import type { PersistencePort } from '@src/business/ports/persistence.ts';
import type { FilesystemPort } from '@src/business/ports/filesystem.ts';
import type { AiSessionPort } from '@src/business/ports/ai-session.ts';
import type { PromptBuilderPort } from '@src/business/ports/prompt-builder.ts';
import type { OutputParserPort } from '@src/business/ports/output-parser.ts';
import type { UserInteractionPort } from '@src/business/ports/user-interaction.ts';
import type { LoggerPort } from '@src/business/ports/logger.ts';
import type { ExternalPort } from '@src/business/ports/external.ts';
import type { SignalBusPort } from '@src/business/ports/signal-bus.ts';
import { pipeline } from '@src/business/pipelines/framework/helpers.ts';
import type { PipelineDefinition, PipelineStep } from '@src/business/pipelines/framework/types.ts';
import type { DomainResult } from '@src/domain/types.ts';
import { Result } from '@src/domain/types.ts';
import type { ExecuteTasksUseCase } from '@src/business/usecases/execute.ts';
import type { PerTaskContext } from './per-task-context.ts';
import { branchPreflight } from './steps/branch-preflight.ts';
import { contractNegotiate } from './steps/contract-negotiate.ts';
import { markInProgress } from './steps/mark-in-progress.ts';
import { executeTask } from './steps/execute-task.ts';
import { storeVerification } from './steps/store-verification.ts';
import { postTaskCheck } from './steps/post-task-check.ts';
import { evaluateTask } from './steps/evaluate-task.ts';
import { recoverDirtyTree } from './steps/recover-dirty-tree.ts';
import { markDone } from './steps/mark-done.ts';

/**
 * Adapter graph required by the per-task pipeline.
 *
 * `signalBus` is injected directly through `PerTaskDeps` — the per-task
 * pipeline runs inside `forEachTask`'s worker pool (see
 * `src/business/pipelines/execute.ts`), which owns the shared rate-limit
 * coordinator. The signal bus passed here is the same one wired into
 * `ExecuteDeps`, so emissions flow to the same sinks the outer pipeline
 * uses.
 */
export interface PerTaskDeps {
  persistence: PersistencePort;
  fs: FilesystemPort;
  aiSession: AiSessionPort;
  promptBuilder: PromptBuilderPort;
  parser: OutputParserPort;
  ui: UserInteractionPort;
  logger: LoggerPort;
  external: ExternalPort;
  signalBus: SignalBusPort;
  /**
   * Shared session-id tracker — passed down to the `execute-task` step so a
   * rate-limit-captured session ID can be threaded into the next spawn as
   * `--resume <id>`. Lifecycle is owned by the outer `execute-tasks` step:
   * it populates the map in the retry policy and clears entries on settle.
   * Optional — when omitted, the step always launches fresh (matches the
   * unit-test default where resume is not exercised).
   */
  taskSessionIds?: Map<string, string>;
}

/**
 * Build the per-task sub-pipeline.
 *
 * Step order (happy path):
 *   1. branch-preflight     — verify sprint branch (no auto-recovery)
 *   2. contract-negotiate   — write `<sprintDir>/contracts/<taskId>.md`
 *   3. mark-in-progress     — persist status + emit `task-started`
 *   4. execute-task         — delegate to `useCase.executeOneTask`
 *   5. store-verification   — persist verified flag if set
 *   6. post-task-check      — run the post-task check gate
 *   7. evaluate-task        — nested evaluator pipeline (REQ-12 live config)
 *   8. recover-dirty-tree   — auto-commit on the harness's behalf if dirty
 *   9. mark-done            — persist status + emit `task-finished`
 *
 * Failure semantics: each step short-circuits via `Result.error` and the
 * scheduler's `retryPolicy` decides the response. `evaluate-task` is the
 * only step that swallows all its failure modes — see its docstring for
 * why the evaluator is advisory.
 */
export function createPerTaskPipeline(
  deps: PerTaskDeps,
  useCase: ExecuteTasksUseCase,
  options: ExecutionOptions = {}
): PipelineDefinition<PerTaskContext> {
  const trace = withStepTrace(deps.signalBus);
  return pipeline<PerTaskContext>('per-task', [
    trace(branchPreflight({ external: deps.external, persistence: deps.persistence })),
    trace(contractNegotiate({ persistence: deps.persistence, fs: deps.fs })),
    trace(markInProgress({ persistence: deps.persistence, signalBus: deps.signalBus })),
    trace(executeTask({ useCase, options, taskSessionIds: deps.taskSessionIds, logger: deps.logger })),
    trace(storeVerification({ persistence: deps.persistence, logger: deps.logger })),
    trace(postTaskCheck({ useCase })),
    trace(
      evaluateTask({
        persistence: deps.persistence,
        fs: deps.fs,
        aiSession: deps.aiSession,
        promptBuilder: deps.promptBuilder,
        parser: deps.parser,
        ui: deps.ui,
        logger: deps.logger,
        external: deps.external,
        useCase,
        options,
      })
    ),
    trace(
      recoverDirtyTree({
        persistence: deps.persistence,
        external: deps.external,
        logger: deps.logger,
        signalBus: deps.signalBus,
      })
    ),
    trace(markDone({ persistence: deps.persistence, logger: deps.logger, signalBus: deps.signalBus })),
  ]);
}

/**
 * Wrap a per-task step so it emits `task-step` bus events at start / finish.
 * The dashboard uses these to render a live "current step" label per running
 * task. Emission is best-effort and never affects step semantics.
 */
function withStepTrace(signalBus: SignalBusPort): (step: PipelineStep<PerTaskContext>) => PipelineStep<PerTaskContext> {
  return (inner) => ({
    name: inner.name,
    execute: inner.execute,
    hooks: {
      pre: async (ctx): Promise<DomainResult<PerTaskContext>> => {
        signalBus.emit({
          type: 'task-step',
          sprintId: ctx.sprint.id,
          taskId: ctx.task.id,
          stepName: inner.name,
          phase: 'start',
          timestamp: new Date(),
        });
        const prior = await inner.hooks?.pre?.(ctx);
        return prior ?? Result.ok(ctx);
      },
      post: async (ctx, result): Promise<DomainResult<Partial<PerTaskContext>>> => {
        const prior = await inner.hooks?.post?.(ctx, result);
        signalBus.emit({
          type: 'task-step',
          sprintId: ctx.sprint.id,
          taskId: ctx.task.id,
          stepName: inner.name,
          phase: 'finish',
          timestamp: new Date(),
        });
        return prior ?? Result.ok({});
      },
    },
  });
}
