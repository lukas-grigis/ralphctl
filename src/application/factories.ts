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

/** Create an ExecuteTasksUseCase with wired dependencies. */
export function createExecuteUseCase(shared: SharedDeps, auto = false): ExecuteTasksUseCase {
  const { aiSession, promptBuilder, parser, ui, external } = createAiDeps(auto);
  return new ExecuteTasksUseCase(
    shared.persistence,
    aiSession,
    promptBuilder,
    parser,
    ui,
    shared.logger,
    external,
    shared.filesystem,
    shared.signalParser,
    shared.signalHandler,
    shared.signalBus
  );
}
