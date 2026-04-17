import type { SharedDeps } from './shared.ts';
import type { AiSessionPort } from '@src/business/ports/ai-session.ts';
import type { PromptBuilderPort } from '@src/business/ports/prompt-builder.ts';
import type { OutputParserPort } from '@src/business/ports/output-parser.ts';
import type { UserInteractionPort } from '@src/business/ports/user-interaction.ts';
import type { ExternalPort } from '@src/business/ports/external.ts';
import { RefineTicketRequirementsUseCase } from '@src/business/usecases/refine.ts';
import { IdeateAndPlanUseCase, PlanSprintTasksUseCase } from '@src/business/usecases/plan.ts';
import { ExecuteTasksUseCase } from '@src/business/usecases/execute.ts';
import { EvaluateTaskUseCase } from '@src/business/usecases/evaluate.ts';
import { createRefinePipeline as buildRefinePipeline, type RefineOptions } from '@src/business/pipelines/refine.ts';
import { createPlanPipeline as buildPlanPipeline, type PlanOptions } from '@src/business/pipelines/plan.ts';
import {
  createIdeatePipeline as buildIdeatePipeline,
  type IdeaInput,
  type IdeateOptions,
} from '@src/business/pipelines/ideate.ts';
import {
  createEvaluatorPipeline as buildEvaluatorPipeline,
  type EvaluateOptions,
} from '@src/business/pipelines/evaluate.ts';
import {
  createExecuteSprintPipeline as buildExecutePipeline,
  type ExecuteOptions,
} from '@src/business/pipelines/execute.ts';
import {
  createPerTaskPipeline as buildPerTaskPipeline,
  type PerTaskDeps,
} from '@src/business/pipelines/execute/per-task-pipeline.ts';
import type { ExecutionOptions } from '@src/domain/context.ts';
import { ProviderAiSessionAdapter } from '@src/integration/ai/session-adapter.ts';
import { TextPromptBuilderAdapter } from '@src/integration/ai/prompt-builder-adapter.ts';
import { DefaultOutputParserAdapter } from '@src/integration/ai/output-parser-adapter.ts';
import { AutoUserAdapter, InteractiveUserAdapter } from '@src/integration/user-interaction/user-interaction-adapter.ts';
import { DefaultExternalAdapter } from '@src/integration/external/external-adapter.ts';

/** Lazy AI workflow dependencies — created fresh per command invocation. */
interface AiDeps {
  aiSession: AiSessionPort;
  promptBuilder: PromptBuilderPort;
  parser: OutputParserPort;
  ui: UserInteractionPort;
  external: ExternalPort;
}

/** Create lazy AI workflow dependencies (only when an AI command is invoked). */
function createAiDeps(auto: boolean): AiDeps {
  return {
    aiSession: new ProviderAiSessionAdapter(),
    promptBuilder: new TextPromptBuilderAdapter(),
    parser: new DefaultOutputParserAdapter(),
    ui: auto ? new AutoUserAdapter() : new InteractiveUserAdapter(),
    external: new DefaultExternalAdapter(),
  };
}

/** Create a RefineTicketRequirementsUseCase with wired dependencies. */
export function createRefineUseCase(shared: SharedDeps, auto = false): RefineTicketRequirementsUseCase {
  const { aiSession, promptBuilder, parser, ui, external } = createAiDeps(auto);
  return new RefineTicketRequirementsUseCase(
    shared.persistence,
    aiSession,
    promptBuilder,
    parser,
    ui,
    shared.logger,
    external,
    shared.filesystem
  );
}

/**
 * Build the refine pipeline with the shared adapter graph.
 *
 * The pipeline owns orchestration (load-sprint → assert-draft →
 * refine-tickets → export-requirements). `createRefineUseCase` is still
 * exported for tests and any non-CLI call sites, but CLI callers should
 * prefer this pipeline factory.
 */
export function createRefinePipeline(shared: SharedDeps, options: RefineOptions = {}) {
  const { aiSession, promptBuilder, parser, ui, external } = createAiDeps(options.auto ?? false);
  return buildRefinePipeline(
    {
      persistence: shared.persistence,
      fs: shared.filesystem,
      aiSession,
      promptBuilder,
      parser,
      ui,
      logger: shared.logger,
      external,
    },
    options
  );
}

/** Create a PlanSprintTasksUseCase with wired dependencies. */
export function createPlanUseCase(shared: SharedDeps, auto = false): PlanSprintTasksUseCase {
  const { aiSession, promptBuilder, parser, ui, external } = createAiDeps(auto);
  return new PlanSprintTasksUseCase(
    shared.persistence,
    aiSession,
    promptBuilder,
    parser,
    ui,
    shared.logger,
    external,
    shared.filesystem
  );
}

/**
 * Build the plan pipeline with the shared adapter graph.
 *
 * The pipeline owns orchestration (load-sprint → assert-draft →
 * assert-all-approved → run-plan → reorder-dependencies).
 * `createPlanUseCase` is still exported for tests and any non-CLI call
 * sites, but CLI callers should prefer this pipeline factory.
 */
export function createPlanPipeline(shared: SharedDeps, options: PlanOptions = {}) {
  const { aiSession, promptBuilder, parser, ui, external } = createAiDeps(options.auto ?? false);
  return buildPlanPipeline(
    {
      persistence: shared.persistence,
      fs: shared.filesystem,
      aiSession,
      promptBuilder,
      parser,
      ui,
      logger: shared.logger,
      external,
    },
    options
  );
}

/** Create an IdeateAndPlanUseCase with wired dependencies. */
export function createIdeateUseCase(shared: SharedDeps, auto = false): IdeateAndPlanUseCase {
  const { aiSession, promptBuilder, parser, ui, external } = createAiDeps(auto);
  return new IdeateAndPlanUseCase(
    shared.persistence,
    aiSession,
    promptBuilder,
    parser,
    ui,
    shared.logger,
    external,
    shared.filesystem
  );
}

/**
 * Build the ideate pipeline with the shared adapter graph.
 *
 * The pipeline owns orchestration (load-sprint → assert-draft →
 * assert-project-provided → run-ideation → reorder-dependencies).
 * `createIdeateUseCase` is still exported for tests and any non-CLI call
 * sites, but CLI callers should prefer this pipeline factory.
 */
export function createIdeatePipeline(shared: SharedDeps, idea: IdeaInput, options: IdeateOptions = {}) {
  const { aiSession, promptBuilder, parser, ui, external } = createAiDeps(options.auto ?? false);
  return buildIdeatePipeline(
    {
      persistence: shared.persistence,
      fs: shared.filesystem,
      aiSession,
      promptBuilder,
      parser,
      ui,
      logger: shared.logger,
      external,
    },
    idea,
    options
  );
}

/** Create an EvaluateTaskUseCase with wired dependencies. */
export function createEvaluateUseCase(shared: SharedDeps, auto = false): EvaluateTaskUseCase {
  const { aiSession, promptBuilder, parser, ui } = createAiDeps(auto);
  return new EvaluateTaskUseCase(
    shared.persistence,
    aiSession,
    promptBuilder,
    parser,
    ui,
    shared.logger,
    shared.filesystem
  );
}

/**
 * Build the evaluator pipeline with the shared adapter graph.
 *
 * The pipeline owns orchestration (load-sprint → load-task →
 * check-already-evaluated → run-evaluator-loop). The per-task pipeline's
 * `evaluate-task` step composes this factory's output as a nested inner
 * pipeline so generator and evaluator share the same framework surface.
 *
 * Evaluator doesn't need `external` (no git/gh), so only the AI-session
 * slice of `createAiDeps` is used.
 */
export function createEvaluatorPipeline(shared: SharedDeps, options: EvaluateOptions = {}) {
  const { aiSession, promptBuilder, parser, ui } = createAiDeps(false);
  return buildEvaluatorPipeline(
    {
      persistence: shared.persistence,
      fs: shared.filesystem,
      aiSession,
      promptBuilder,
      parser,
      ui,
      logger: shared.logger,
    },
    options
  );
}

/**
 * Build the execute pipeline with the shared adapter graph.
 *
 * The pipeline owns orchestration (load-sprint → check-preconditions →
 * resolve-branch → auto-activate → assert-active → prepare-tasks →
 * ensure-branches → run-check-scripts → execute-tasks → feedback-loop).
 *
 * `execute-tasks` composes `forEachTask` + the per-task pipeline directly —
 * no monolithic executor behind the scenes. The use case
 * (`ExecuteTasksUseCase`) is still constructed internally by the pipeline
 * so its `executeOneTask` / `runPostTaskCheck` / `runFeedbackLoopOnly` /
 * `getEvaluationConfig` methods can be delegated to from the per-task
 * pipeline steps; callers never need the use case directly.
 */
export function createExecuteSprintPipeline(shared: SharedDeps, options: ExecuteOptions = {}) {
  const { aiSession, promptBuilder, parser, ui, external } = createAiDeps(false);
  return buildExecutePipeline(
    {
      persistence: shared.persistence,
      fs: shared.filesystem,
      aiSession,
      promptBuilder,
      parser,
      ui,
      logger: shared.logger,
      external,
      signalParser: shared.signalParser,
      signalHandler: shared.signalHandler,
      signalBus: shared.signalBus,
    },
    options
  );
}

/**
 * Build the per-task sub-pipeline with the shared adapter graph.
 *
 * The per-task pipeline is the per-item body of the executor's scheduler:
 * branch-preflight → mark-in-progress → execute-task → store-verification
 * → post-task-check → evaluate-task → mark-done. Commit 3 will wire this
 * into `forEachTask` as the inner pipeline; for now the factory exists so
 * callers (and integration tests) can build it without threading every
 * adapter themselves.
 *
 * Takes the parent `ExecuteTasksUseCase` so `execute-task` and
 * `post-task-check` can delegate to its methods and `evaluate-task` can
 * read the live `evaluationIterations` config (REQ-12).
 */
export function createPerTaskPipeline(
  shared: SharedDeps,
  useCase: ExecuteTasksUseCase,
  options: ExecutionOptions = {}
) {
  const { aiSession, promptBuilder, parser, ui, external } = createAiDeps(false);
  const deps: PerTaskDeps = {
    persistence: shared.persistence,
    fs: shared.filesystem,
    aiSession,
    promptBuilder,
    parser,
    ui,
    logger: shared.logger,
    external,
    signalBus: shared.signalBus,
  };
  return buildPerTaskPipeline(deps, useCase, options);
}
