import type { Sprint } from '@src/domain/models.ts';
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
import type { SkillsPort } from '@src/business/ports/skills.ts';
import { pipeline, renameStep, step } from '@src/business/pipelines/framework/helpers.ts';
import { loadSprintStep } from '@src/business/pipelines/steps/load-sprint.ts';
import { assertSprintStatusStep } from '@src/business/pipelines/steps/assert-sprint-status.ts';
import {
  cleanupSkillsStep,
  linkSkillsStep,
  type WithLinkedSkills,
} from '@src/business/pipelines/steps/skill-lifecycle.ts';
import { type RefineSummary, RefineTicketRequirementsUseCase } from '@src/business/usecases/refine.ts';

/** Context accumulated by the refine pipeline. */
interface RefineContext extends StepContext, WithLinkedSkills {
  refineSummary?: RefineSummary;
}

/** Command-line options threaded into the `refine-tickets` step. */
export interface RefineOptions {
  project?: string;
  auto?: boolean;
}

/** Adapters required to build the refine pipeline. */
export interface RefineDeps {
  persistence: PersistencePort;
  fs: FilesystemPort;
  aiSession: AiSessionPort;
  promptBuilder: PromptBuilderPort;
  parser: OutputParserPort;
  ui: UserInteractionPort;
  logger: LoggerPort;
  external: ExternalPort;
  skills: SkillsPort;
}

/**
 * Refine-tickets step: delegates the per-ticket HITL loop to
 * `RefineTicketRequirementsUseCase.execute()`.
 *
 * The use case already handles the per-ticket loop (project lookup, AI
 * session, approval prompt). Exposing it as a single step keeps the
 * pipeline shape without gutting the use case in the same commit — a
 * future pass can split the loop into per-ticket steps.
 */
function refineTicketsStep(useCase: RefineTicketRequirementsUseCase, options: RefineOptions) {
  return step('refine-tickets', async (ctx: RefineContext): Promise<DomainResult<Partial<RefineContext>>> => {
    const result = await useCase.execute(ctx.sprintId, options);
    if (!result.ok) {
      return Result.error(result.error);
    }
    const partial: Partial<RefineContext> = { refineSummary: result.value };
    return Result.ok(partial);
  });
}

/**
 * Export-requirements step: writes `requirements.md` when every ticket is
 * approved. This is the single source of orchestration truth for the
 * markdown export — the use case no longer exports internally.
 *
 * No-op when `refineSummary?.allApproved` is falsy. Any export failure is
 * swallowed inside the use case (it logs a warning) so the step always
 * succeeds — the markdown is a convenience artifact, not a correctness
 * guarantee.
 */
function exportRequirementsStep(useCase: RefineTicketRequirementsUseCase, persistence: PersistencePort) {
  return step('export-requirements', async (ctx: RefineContext): Promise<DomainResult<Partial<RefineContext>>> => {
    if (!ctx.refineSummary?.allApproved) {
      const empty: Partial<RefineContext> = {};
      return Result.ok(empty);
    }

    // Re-read the sprint to capture approvals written during
    // `refine-tickets` — `ctx.sprint` was loaded before the per-ticket
    // approval loop ran.
    let sprint: Sprint;
    try {
      sprint = await persistence.getSprint(ctx.sprintId);
    } catch (err) {
      if (err instanceof DomainError) return Result.error(err);
      return Result.error(new ParseError(err instanceof Error ? err.message : String(err)));
    }

    await useCase.exportRequirements(sprint);
    const empty: Partial<RefineContext> = {};
    return Result.ok(empty);
  });
}

/**
 * Build the refine pipeline. Happy-path step order:
 *   load-sprint → assert-draft → link-skills → refine-tickets →
 *   export-requirements → cleanup-skills
 *
 * Behavior matches `ralphctl sprint refine` pre-pipeline exactly: same
 * prompts, same approvals, same markdown export when all tickets approve.
 *
 * `link-skills` resolves the `refine` skill set (built-in + user) and
 * symlinks each into every ticket's refinement dir before the AI sessions
 * spawn. `cleanup-skills` drains the symlinks at the tail; the
 * lifecycle module also installs a `process.on('exit')` reaper so an
 * interrupt before this step still leaves working dirs clean.
 */
export function createRefinePipeline(deps: RefineDeps, options: RefineOptions = {}) {
  const useCase = new RefineTicketRequirementsUseCase(
    deps.persistence,
    deps.aiSession,
    deps.promptBuilder,
    deps.parser,
    deps.ui,
    deps.logger,
    deps.external,
    deps.fs
  );

  return pipeline('refine', [
    loadSprintStep<RefineContext>(deps.persistence),
    renameStep('assert-draft', assertSprintStatusStep<RefineContext>(['draft'], 'refine')),
    linkSkillsStep<RefineContext>(deps.skills, 'refine', (ctx) => {
      // Each ticket spawns its own AI session inside its refinement dir; the
      // dirs may not exist yet (the use case ensures them per-ticket), so
      // the link step pre-creates them so Claude finds .claude/skills/ on
      // session start.
      const sprint = ctx.sprint;
      if (!sprint) return [];
      return sprint.tickets.map((t) => deps.fs.getRefinementDir(sprint.id, t.id));
    }),
    refineTicketsStep(useCase, options),
    exportRequirementsStep(useCase, deps.persistence),
    cleanupSkillsStep<RefineContext>(deps.skills, deps.logger),
  ]);
}
