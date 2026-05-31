import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { Project } from '@src/domain/entity/project.ts';
import { updateRepository } from '@src/domain/entity/project.ts';
import type { Repository } from '@src/domain/entity/repository.ts';
import type { ProjectRepository } from '@src/domain/repository/project/project-repository.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import type { DetectScriptsCtx } from '@src/application/flows/detect-scripts/ctx.ts';

export interface WriteDetectScriptsLeafDeps {
  readonly projectRepo: ProjectRepository;
  readonly logger: Logger;
}

interface WriteInput {
  readonly accepted: boolean;
  readonly project: Project;
  readonly repository: Repository;
  readonly proposal: {
    readonly proposedSetupScript?: string;
    readonly proposedVerifyScript?: string;
  };
}

/**
 * Terminal write leaf for detect-scripts.
 *
 * - When `accepted !== true` → no-op. The trace records `completed` and the project / repo
 *   stay untouched. The "no proposals" branch from `confirm` also lands here (accepted=false).
 * - When accepted → apply each non-undefined proposed value to the repository entity via
 *   `updateRepository`, then persist the project via `projectRepo.save`. Values that were not
 *   proposed (tag omitted) are left untouched on the existing repo.
 *
 * Mapping note: the AI emits `<verify-script>` (the post-task gate); the repository field that
 * holds it is `verifyScript`. The prompt-tag wire name and the domain field name are aligned
 * after the v0.7.0 rename.
 */
const writeUseCase = async (
  deps: WriteDetectScriptsLeafDeps,
  input: WriteInput
): Promise<Result<void, DomainError>> => {
  const log = deps.logger.named('detect-scripts.write');
  if (!input.accepted) {
    log.info('skipping write — proposal not accepted', {
      repositoryId: String(input.repository.id),
    });
    return Result.ok(undefined);
  }

  const updated = updateRepository(input.project, input.repository.id, {
    ...(input.proposal.proposedSetupScript !== undefined ? { setupScript: input.proposal.proposedSetupScript } : {}),
    ...(input.proposal.proposedVerifyScript !== undefined ? { verifyScript: input.proposal.proposedVerifyScript } : {}),
  });
  if (!updated.ok) return Result.error(updated.error);

  const saved = await deps.projectRepo.save(updated.value);
  if (!saved.ok) return Result.error(saved.error);

  log.info(`wrote scripts for repo ${input.repository.name}`, {
    repositoryId: String(input.repository.id),
    setupWritten: input.proposal.proposedSetupScript !== undefined,
    verifyWritten: input.proposal.proposedVerifyScript !== undefined,
  });

  return Result.ok(undefined);
};

export const writeDetectScriptsLeaf = (deps: WriteDetectScriptsLeafDeps): Element<DetectScriptsCtx> =>
  leaf<DetectScriptsCtx, WriteInput, void>('write', {
    useCase: {
      execute: async (input) => writeUseCase(deps, input),
    },
    input: (ctx) => {
      if (ctx.project === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-write',
          attemptedAction: 'write',
          message: 'write: ctx.project is undefined — load-project must run first',
        });
      }
      if (ctx.repository === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-write',
          attemptedAction: 'write',
          message: 'write: ctx.repository is undefined — pick-repository must run first',
        });
      }
      if (ctx.proposal === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-write',
          attemptedAction: 'write',
          message: 'write: ctx.proposal is undefined — propose must run first',
        });
      }
      return {
        accepted: ctx.accepted ?? false,
        project: ctx.project,
        repository: ctx.repository,
        proposal: {
          ...(ctx.proposal.proposedSetupScript !== undefined
            ? { proposedSetupScript: ctx.proposal.proposedSetupScript }
            : {}),
          ...(ctx.proposal.proposedVerifyScript !== undefined
            ? { proposedVerifyScript: ctx.proposal.proposedVerifyScript }
            : {}),
        },
      };
    },
    output: (ctx) => ctx,
  });
