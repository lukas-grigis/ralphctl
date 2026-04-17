import type { SharedDeps } from './shared.ts';
import type { AiSessionPort } from '@src/business/ports/ai-session.ts';
import type { PromptBuilderPort } from '@src/business/ports/prompt-builder.ts';
import type { OutputParserPort } from '@src/business/ports/output-parser.ts';
import type { UserInteractionPort } from '@src/business/ports/user-interaction.ts';
import type { ExternalPort } from '@src/business/ports/external.ts';
import { createRefinePipeline as buildRefinePipeline, type RefineOptions } from '@src/business/pipelines/refine.ts';
import { createPlanPipeline as buildPlanPipeline, type PlanOptions } from '@src/business/pipelines/plan.ts';
import {
  createIdeatePipeline as buildIdeatePipeline,
  type IdeaInput,
  type IdeateOptions,
} from '@src/business/pipelines/ideate.ts';
import {
  createExecuteSprintPipeline as buildExecutePipeline,
  type ExecuteOptions,
} from '@src/business/pipelines/execute.ts';
import { ProviderAiSessionAdapter } from '@src/integration/ai/session/session-adapter.ts';
import { TextPromptBuilderAdapter } from '@src/integration/ai/prompts/prompt-builder-adapter.ts';
import { DefaultOutputParserAdapter } from '@src/integration/ai/output/output-parser-adapter.ts';
import { AutoUserAdapter, InteractiveUserAdapter } from '@src/integration/user-interaction-adapter.ts';
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

/**
 * Build the refine pipeline with the shared adapter graph.
 *
 * The pipeline owns orchestration (load-sprint → assert-draft →
 * refine-tickets → export-requirements).
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

/**
 * Build the plan pipeline with the shared adapter graph.
 *
 * The pipeline owns orchestration (load-sprint → assert-draft →
 * assert-all-approved → run-plan → reorder-dependencies).
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

/**
 * Build the ideate pipeline with the shared adapter graph.
 *
 * The pipeline owns orchestration (load-sprint → assert-draft →
 * assert-project-provided → run-ideation → reorder-dependencies).
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

/**
 * Build the execute pipeline with the shared adapter graph.
 *
 * The pipeline owns orchestration (load-sprint → check-preconditions →
 * resolve-branch → auto-activate → assert-active → prepare-tasks →
 * ensure-branches → run-check-scripts → execute-tasks → feedback-loop).
 *
 * `execute-tasks` composes `forEachTask` + the per-task pipeline directly —
 * no monolithic executor behind the scenes.
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
      createRateLimitCoordinator: shared.createRateLimitCoordinator,
    },
    options
  );
}
