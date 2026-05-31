import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import { type Project, updateRepository } from '@src/domain/entity/project.ts';
import type { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import type { Save } from '@src/domain/repository/_base/save.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import type { ReadinessCtx } from '@src/application/flows/readiness/ctx.ts';

/**
 * Terminal leaf — runs ONCE after the per-provider fan-out completes. Unions every tool's
 * `ctx.entries[tool].proposal.proposedSkillSuggestions` and persists the result onto the
 * picked repository's `Repository.suggestedSkills` via a single `projectRepo.save()`.
 *
 * Design constraints (audit follow-up):
 *  - **Records what was OFFERED, not what was installed.** The leaf is NOT gated on the
 *    `accepted` flag: a declined readiness proposal still leaves a durable record of what the
 *    AI recommended, so the operator can revisit the suggestions later.
 *  - **Exactly one save per repository.** It runs after the whole fan-out (not per provider),
 *    so two providers proposing skills can't race two `save()` calls on the same project.
 *  - **No-op on zero suggestions.** When no tool proposed any skill, the leaf skips the save
 *    entirely (a clean repo round-trips without an empty `suggestedSkills` array on disk).
 *
 * `setRepositorySuggestedSkills` (via `updateRepository`) trims / de-duplicates the union, so
 * overlapping suggestions across providers collapse to one entry.
 */
export interface PersistSuggestedSkillsLeafDeps {
  readonly projectRepo: Save<Project>;
  readonly logger: Logger;
}

interface PersistSuggestedSkillsInput {
  readonly project: Project;
  readonly repositoryId: RepositoryId;
  readonly suggestions: readonly string[];
}

const persistSuggestedSkillsUseCase = async (
  deps: PersistSuggestedSkillsLeafDeps,
  input: PersistSuggestedSkillsInput
): Promise<Result<void, DomainError>> => {
  const log = deps.logger.named('readiness.persist-suggested-skills');
  if (input.suggestions.length === 0) {
    log.info('no skill suggestions across providers — skipping persist');
    return Result.ok(undefined);
  }

  const updated = updateRepository(input.project, input.repositoryId, { suggestedSkills: input.suggestions });
  if (!updated.ok) return Result.error(updated.error);

  const saved = await deps.projectRepo.save(updated.value);
  if (!saved.ok) return Result.error(saved.error);

  log.info(`persisted ${input.suggestions.length} suggested skill(s) on the repository`, {
    suggestions: input.suggestions,
  });
  return Result.ok(undefined);
};

const LEAF_NAME = 'persist-suggested-skills';

export const persistSuggestedSkillsLeaf = (deps: PersistSuggestedSkillsLeafDeps): Element<ReadinessCtx> =>
  leaf<ReadinessCtx, PersistSuggestedSkillsInput, void>(LEAF_NAME, {
    useCase: {
      execute: async (input) => persistSuggestedSkillsUseCase(deps, input),
    },
    input: (ctx) => {
      if (ctx.project === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-persist-suggested-skills',
          attemptedAction: LEAF_NAME,
          message: `${LEAF_NAME}: ctx.project is undefined — load-project must run first`,
        });
      }
      if (ctx.repository === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-persist-suggested-skills',
          attemptedAction: LEAF_NAME,
          message: `${LEAF_NAME}: ctx.repository is undefined — pick-repository must run first`,
        });
      }
      // Union every per-tool entry's proposed suggestions. We iterate `ctx.entries` (what the
      // fan-out actually populated) rather than `ctx.tools` so the union reflects the providers
      // that genuinely ran. `updateRepository` trims / dedupes, so overlaps across providers
      // collapse — we just flatten here.
      const suggestions = Object.values(ctx.entries).flatMap(
        (entry) => entry?.proposal?.proposedSkillSuggestions ?? []
      );
      return { project: ctx.project, repositoryId: ctx.repository.id, suggestions };
    },
    output: (ctx) => ctx,
  });
