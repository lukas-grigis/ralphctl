import type { ExecutionOptions } from '@src/domain/context.ts';
import type { PersistencePort } from '@src/domain/repositories/persistence.ts';
import type { FilesystemPort } from '@src/domain/repositories/filesystem.ts';
import type { AiSessionPort } from '@src/business/ports/ai-session.ts';
import type { PromptBuilderPort } from '@src/business/ports/prompt-builder.ts';
import type { OutputParserPort } from '@src/business/ports/output-parser.ts';
import type { UserInteractionPort } from '@src/business/ports/user-interaction.ts';
import type { LoggerPort } from '@src/business/ports/logger.ts';
import type { ExternalPort } from '@src/business/ports/external.ts';
import type { SignalBusPort } from '@src/business/ports/signal-bus.ts';
import { pipeline } from '@src/business/pipeline/helpers.ts';
import type { PipelineDefinition } from '@src/business/pipeline/types.ts';
import type { ExecuteTasksUseCase } from '@src/business/usecases/execute.ts';
import type { PerTaskContext } from './per-task-context.ts';
import { branchPreflight } from './steps/branch-preflight.ts';
import { markInProgress } from './steps/mark-in-progress.ts';
import { executeTask } from './steps/execute-task.ts';
import { storeVerification } from './steps/store-verification.ts';
import { postTaskCheck } from './steps/post-task-check.ts';
import { evaluateTask } from './steps/evaluate-task.ts';
import { markDone } from './steps/mark-done.ts';

/**
 * Adapter graph required by the per-task pipeline.
 *
 * `signalBus` is injected directly rather than pulled from
 * `ctx.__services.signalBus`. The per-task pipeline runs inside
 * `forEachTask`'s worker pool (see `src/business/pipelines/execute.ts`),
 * which also owns the shared rate-limit coordinator; the signal bus is
 * the injected one from `ExecuteDeps` so emissions flow to the same sinks
 * the outer pipeline uses.
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
}

/**
 * Build the per-task sub-pipeline.
 *
 * Step order (happy path):
 *   1. branch-preflight     — verify sprint branch (no auto-recovery)
 *   2. mark-in-progress     — persist status + emit `task-started`
 *   3. execute-task         — delegate to `useCase.executeOneTask`
 *   4. store-verification   — persist verified flag if set
 *   5. post-task-check      — run the post-task check gate
 *   6. evaluate-task        — nested evaluator pipeline (REQ-12 live config)
 *   7. mark-done            — persist status + emit `task-finished` + log
 *
 * Failure semantics (each step short-circuits the pipeline via
 * `Result.error` — `executePipeline` stops and the scheduler's
 * `retryPolicy` in commit 3 decides the response):
 *   - branch mismatch → `StorageError` → requeue up to N times
 *   - task blocked / `SpawnError` (rate-limit) → retry or pause-all
 *   - post-task-check failure → `ParseError` → `skip-repo`
 *
 * Evaluator failure is the only non-fatal failure: `evaluate-task`
 * swallows errors from the inner pipeline, logs a warning, and returns
 * `Result.ok` so `mark-done` still runs. This matches the pre-pipeline
 * behaviour where `EvaluateTaskUseCase.execute()`'s result was never
 * checked.
 */
export function createPerTaskPipeline(
  deps: PerTaskDeps,
  useCase: ExecuteTasksUseCase,
  options: ExecutionOptions = {}
): PipelineDefinition<PerTaskContext> {
  return pipeline<PerTaskContext>('per-task', [
    branchPreflight({ external: deps.external }),
    markInProgress({ persistence: deps.persistence, signalBus: deps.signalBus }),
    executeTask({ useCase, options }),
    storeVerification({ persistence: deps.persistence, logger: deps.logger }),
    postTaskCheck({ useCase }),
    evaluateTask({
      persistence: deps.persistence,
      fs: deps.fs,
      aiSession: deps.aiSession,
      promptBuilder: deps.promptBuilder,
      parser: deps.parser,
      ui: deps.ui,
      logger: deps.logger,
      useCase,
      options,
    }),
    markDone({ persistence: deps.persistence, logger: deps.logger, signalBus: deps.signalBus }),
  ]);
}
