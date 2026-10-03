import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { Project } from '@src/domain/entity/project.ts';
import { updateRepository } from '@src/domain/entity/project.ts';
import type { Repository } from '@src/domain/entity/repository.ts';
import type { ProjectRepository } from '@src/domain/repository/project/project-repository.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import type { DetectSkillsCtx } from '@src/application/flows/detect-skills/ctx.ts';
import { assertCtxField } from '@src/application/flows/_shared/_engine/assert-ctx-field.ts';

export interface WriteDetectSkillsLeafDeps {
  readonly projectRepo: ProjectRepository;
  readonly logger: Logger;
}

interface WriteInput {
  readonly accepted: boolean;
  readonly project: Project;
  readonly repository: Repository;
  readonly proposal: {
    readonly proposedSetupSkill?: string;
    readonly proposedVerifySkill?: string;
  };
}

/**
 * Terminal write leaf. No-op when `accepted !== true`. Otherwise applies each non-undefined
 * proposed body to the repository entity via `updateRepository` and persists the project.
 * Mapping is direct: `proposedSetupSkill` → `Repository.setupSkill`,
 * `proposedVerifySkill` → `Repository.verifySkill`.
 */
const writeUseCase = async (deps: WriteDetectSkillsLeafDeps, input: WriteInput): Promise<Result<void, DomainError>> => {
  const log = deps.logger.named('detect-skills.write');
  if (!input.accepted) {
    log.info('skipping write — proposal not accepted', {
      repositoryId: String(input.repository.id),
    });
    return Result.ok(undefined);
  }

  const updated = updateRepository(input.project, input.repository.id, {
    ...(input.proposal.proposedSetupSkill !== undefined ? { setupSkill: input.proposal.proposedSetupSkill } : {}),
    ...(input.proposal.proposedVerifySkill !== undefined ? { verifySkill: input.proposal.proposedVerifySkill } : {}),
  });
  if (!updated.ok) return Result.error(updated.error);

  const saved = await deps.projectRepo.save(updated.value);
  if (!saved.ok) return Result.error(saved.error);

  log.info(`wrote skills for repo ${input.repository.name}`, {
    repositoryId: String(input.repository.id),
    setupWritten: input.proposal.proposedSetupSkill !== undefined,
    verifyWritten: input.proposal.proposedVerifySkill !== undefined,
  });

  return Result.ok(undefined);
};

export const writeDetectSkillsLeaf = (deps: WriteDetectSkillsLeafDeps): Element<DetectSkillsCtx> =>
  leaf<DetectSkillsCtx, WriteInput, void>('write', {
    useCase: {
      execute: async (input) => writeUseCase(deps, input),
    },
    input: (ctx) => {
      const project = assertCtxField(ctx, 'project', 'write', 'pre-write');
      const repository = assertCtxField(ctx, 'repository', 'write', 'pre-write');
      const proposal = assertCtxField(ctx, 'proposal', 'write', 'pre-write');
      return {
        accepted: ctx.accepted ?? false,
        project,
        repository,
        proposal: {
          ...(proposal.proposedSetupSkill !== undefined ? { proposedSetupSkill: proposal.proposedSetupSkill } : {}),
          ...(proposal.proposedVerifySkill !== undefined ? { proposedVerifySkill: proposal.proposedVerifySkill } : {}),
        },
      };
    },
    output: (ctx) => ctx,
  });
