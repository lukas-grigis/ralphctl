import type { StepContext } from '@src/domain/context.ts';
import { Result } from '@src/domain/types.ts';
import type { DomainResult } from '@src/domain/types.ts';
import { DomainError, ParseError } from '@src/domain/errors.ts';
import type { PersistencePort } from '@src/domain/repositories/persistence.ts';
import type { FilesystemPort } from '@src/domain/repositories/filesystem.ts';
import type { AiSessionPort } from '@src/business/ports/ai-session.ts';
import type { PromptBuilderPort } from '@src/business/ports/prompt-builder.ts';
import type { OutputParserPort } from '@src/business/ports/output-parser.ts';
import type { UserInteractionPort } from '@src/business/ports/user-interaction.ts';
import type { LoggerPort } from '@src/business/ports/logger.ts';
import type { ExternalPort } from '@src/business/ports/external.ts';
import { step, pipeline, renameStep } from '@src/business/pipeline/helpers.ts';
import { loadSprintStep } from '@src/business/pipelines/steps/load-sprint.ts';
import { assertSprintStatusStep } from '@src/business/pipelines/steps/assert-sprint-status.ts';
import { reorderDependenciesStep } from '@src/business/pipelines/steps/reorder-dependencies.ts';
import { IdeateAndPlanUseCase, type IdeationSummary } from '@src/business/usecases/plan.ts';

/** Context accumulated by the ideate pipeline. */
export interface IdeateContext extends StepContext {
  ideaSummary?: IdeationSummary;
  createdTicketId?: string;
}

/** Command-line options threaded into the `run-ideation` step. */
export interface IdeateOptions {
  auto?: boolean;
  allPaths?: boolean;
  project?: string;
}

/** The idea payload ideation is seeded with. */
export interface IdeaInput {
  title: string;
  description: string;
}

/** Adapters required to build the ideate pipeline. */
export interface IdeateDeps {
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
 * Assert `options.project` is provided.
 *
 * Ideation always targets exactly one project — the CLI resolves it via a
 * prompt or a `--project` flag before the pipeline starts. If it's still
 * missing here, return a `ParseError` with the same wording the pre-pipeline
 * use case surfaced so CLI callers see identical error text.
 *
 * This is an ideate-specific guard — no other pipeline has this shape — so
 * it lives here rather than as a shared step.
 */
function assertProjectProvidedStep(options: IdeateOptions) {
  return step('assert-project-provided', (): DomainResult<Partial<IdeateContext>> => {
    if (!options.project) {
      return Result.error(new ParseError('Project name is required for ideation.'));
    }
    const empty: Partial<IdeateContext> = {};
    return Result.ok(empty) as DomainResult<Partial<IdeateContext>>;
  });
}

/**
 * Run-ideation step: delegates the monolithic ideation flow to
 * `IdeateAndPlanUseCase.execute()`.
 *
 * The use case already owns ticket creation, repo selection, the AI session
 * (auto and interactive), requirement persistence, task validation, and
 * import. Exposing it as a single step keeps the pipeline's major phase
 * boundaries honest — a future pass can decompose this into per-phase steps
 * (create-ticket, select-repos, run-ai, import) without changing user-facing
 * behavior.
 *
 * Writes both `ctx.ideaSummary` (for the CLI to read) and `ctx.createdTicketId`
 * (for pipeline introspection / future extension steps that need the ticket
 * ID on context independent of the summary).
 */
function runIdeationStep(useCase: IdeateAndPlanUseCase, idea: IdeaInput, options: IdeateOptions) {
  return step('run-ideation', async (ctx: IdeateContext): Promise<DomainResult<Partial<IdeateContext>>> => {
    const result = await useCase.execute(ctx.sprintId, idea, options);
    if (!result.ok) {
      return Result.error(result.error);
    }
    const partial: Partial<IdeateContext> = {
      ideaSummary: result.value,
      createdTicketId: result.value.ticketId,
    };
    return Result.ok(partial) as DomainResult<Partial<IdeateContext>>;
  });
}

/**
 * Reorder-dependencies wrapper that no-ops when no tasks were imported.
 *
 * The use case already calls `reorderByDependencies` internally on a
 * successful import. We still expose this step so the pipeline shape
 * documents the phase boundary, but skip the re-run when `importedTasks`
 * is zero — covers both the "AI returned nothing" case and any future
 * short-circuit before DB writes.
 */
function reorderIfImportedStep(persistence: PersistencePort) {
  const inner = reorderDependenciesStep<IdeateContext>(persistence);
  return step('reorder-dependencies', async (ctx: IdeateContext): Promise<DomainResult<Partial<IdeateContext>>> => {
    if (!ctx.ideaSummary || ctx.ideaSummary.importedTasks === 0) {
      const empty: Partial<IdeateContext> = {};
      return Result.ok(empty) as DomainResult<Partial<IdeateContext>>;
    }
    try {
      return await inner.execute(ctx);
    } catch (err) {
      if (err instanceof DomainError) return Result.error(err);
      return Result.error(new ParseError(err instanceof Error ? err.message : String(err)));
    }
  });
}

/**
 * Build the ideate pipeline. Happy-path step order:
 *   load-sprint → assert-draft → assert-project-provided → run-ideation →
 *   reorder-dependencies
 *
 * Behavior matches `ralphctl sprint ideate` pre-pipeline exactly: same
 * ticket creation, same repo selection, same AI session (auto or
 * interactive), same validation and import semantics.
 *
 * The CLI collects `idea` (title + description) interactively before
 * calling this factory, so the idea payload is closed over rather than
 * threaded through the context — matches the use case's existing
 * signature and keeps the prompt UX at the call site.
 */
export function createIdeatePipeline(deps: IdeateDeps, idea: IdeaInput, options: IdeateOptions = {}) {
  const useCase = new IdeateAndPlanUseCase(
    deps.persistence,
    deps.aiSession,
    deps.promptBuilder,
    deps.parser,
    deps.ui,
    deps.logger,
    deps.external,
    deps.fs
  );

  return pipeline<IdeateContext>('ideate', [
    loadSprintStep<IdeateContext>(deps.persistence),
    renameStep('assert-draft', assertSprintStatusStep<IdeateContext>(['draft'], 'ideate')),
    assertProjectProvidedStep(options),
    runIdeationStep(useCase, idea, options),
    reorderIfImportedStep(deps.persistence),
  ]);
}
