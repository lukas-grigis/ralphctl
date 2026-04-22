import type { StepContext } from '@src/domain/context.ts';
import type { DomainResult } from '@src/domain/types.ts';
import { Result } from '@src/domain/types.ts';
import { DomainError, ParseError } from '@src/domain/errors.ts';
import type { PersistencePort } from '@src/business/ports/persistence.ts';
import type { FilesystemPort } from '@src/business/ports/filesystem.ts';
import type { AiSessionPort } from '@src/business/ports/ai-session.ts';
import type { PromptBuilderPort } from '@src/business/ports/prompt-builder.ts';
import type { OutputParserPort } from '@src/business/ports/output-parser.ts';
import type { UserInteractionPort } from '@src/business/ports/user-interaction.ts';
import type { LoggerPort } from '@src/business/ports/logger.ts';
import type { ExternalPort } from '@src/business/ports/external.ts';
import { pipeline, renameStep, step } from '@src/business/pipelines/framework/helpers.ts';
import { loadSprintStep } from '@src/business/pipelines/steps/load-sprint.ts';
import { assertSprintStatusStep } from '@src/business/pipelines/steps/assert-sprint-status.ts';
import { reorderDependenciesStep } from '@src/business/pipelines/steps/reorder-dependencies.ts';
import { PlanSprintTasksUseCase, type PlanSummary } from '@src/business/usecases/plan.ts';

/** Context accumulated by the plan pipeline. */
interface PlanContext extends StepContext {
  planSummary?: PlanSummary;
}

/** Command-line options threaded into the `run-plan` step. */
export interface PlanOptions {
  auto?: boolean;
  allPaths?: boolean;
}

/** Adapters required to build the plan pipeline. */
export interface PlanDeps {
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
 * Assert every ticket in `ctx.sprint` has `requirementStatus === 'approved'`.
 *
 * Surfaces a `ParseError` otherwise — matches the pre-pipeline use case's
 * wording so CLI callers see identical error text. Also fails when the
 * sprint has zero tickets (nothing to plan).
 */
function assertAllApprovedStep() {
  return step('assert-all-approved', (ctx: PlanContext): DomainResult<Partial<PlanContext>> => {
    const sprint = ctx.sprint;
    if (!sprint) {
      return Result.error(new ParseError('assert-all-approved requires ctx.sprint — call loadSprintStep first'));
    }

    if (sprint.tickets.length === 0) {
      return Result.error(new ParseError('No tickets in sprint.'));
    }

    const allApproved = sprint.tickets.every((t) => t.requirementStatus === 'approved');
    if (!allApproved) {
      return Result.error(new ParseError('Not all tickets have approved requirements. Run sprint refine first.'));
    }

    const empty: Partial<PlanContext> = {};
    return Result.ok(empty);
  });
}

/**
 * Run-plan step: delegates the monolithic planning flow to
 * `PlanSprintTasksUseCase.execute()`.
 *
 * The use case already owns the re-plan confirm prompt, repo selection,
 * sprint-context build, AI session, validation, and task import. Exposing
 * it as a single step keeps the pipeline's major phase boundaries honest —
 * a future pass can decompose this into per-phase steps (select-repos,
 * run-ai, validate, import) without changing user-facing behavior.
 */
function runPlanStep(useCase: PlanSprintTasksUseCase, options: PlanOptions) {
  return step('run-plan', async (ctx: PlanContext): Promise<DomainResult<Partial<PlanContext>>> => {
    const result = await useCase.execute(ctx.sprintId, options);
    if (!result.ok) {
      return Result.error(result.error);
    }
    const partial: Partial<PlanContext> = { planSummary: result.value };
    return Result.ok(partial);
  });
}

/**
 * Reorder-dependencies wrapper that no-ops when no tasks were imported.
 *
 * The use case already calls `reorderByDependencies` internally on a
 * successful import. We still expose this step so the pipeline shape
 * documents the phase boundary, but skip the re-run when `importedCount`
 * is zero — that covers both the "user cancelled re-plan" case and any
 * future where `run-plan` short-circuits before any DB writes. The shared
 * `reorderDependenciesStep` stays unchanged (other callers may want an
 * unconditional reorder).
 */
function reorderIfImportedStep(persistence: PersistencePort) {
  const inner = reorderDependenciesStep<PlanContext>(persistence);
  return step('reorder-dependencies', async (ctx: PlanContext): Promise<DomainResult<Partial<PlanContext>>> => {
    if (!ctx.planSummary || ctx.planSummary.importedCount === 0) {
      const empty: Partial<PlanContext> = {};
      return Result.ok(empty);
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
 * Build the plan pipeline. Happy-path step order:
 *   load-sprint → assert-draft → assert-all-approved → run-plan →
 *   reorder-dependencies
 *
 * Behavior matches `ralphctl sprint plan` pre-pipeline exactly: same
 * prompts (re-plan confirm, repo selection), same AI session, same
 * validation, same import semantics, same re-plan replace behavior.
 */
export function createPlanPipeline(deps: PlanDeps, options: PlanOptions = {}) {
  const useCase = new PlanSprintTasksUseCase(
    deps.persistence,
    deps.aiSession,
    deps.promptBuilder,
    deps.parser,
    deps.ui,
    deps.logger,
    deps.external,
    deps.fs
  );

  return pipeline<PlanContext>('plan', [
    loadSprintStep<PlanContext>(deps.persistence),
    renameStep('assert-draft', assertSprintStatusStep<PlanContext>(['draft'], 'plan')),
    assertAllApprovedStep(),
    runPlanStep(useCase, options),
    reorderIfImportedStep(deps.persistence),
  ]);
}
