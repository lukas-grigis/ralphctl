import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import type { Element } from '@src/application/chain/element.ts';
import { sequential } from '@src/application/chain/build/sequential.ts';
import { loadProjectLeaf } from '@src/application/flows/_shared/project/load.ts';
import { pickRepositoryLeaf } from '@src/application/flows/_shared/project/pick-repository.ts';
import { allocateRunDirLeaf } from '@src/application/flows/_shared/allocate-run-dir.ts';
import type { DetectSkillsCtx } from '@src/application/flows/detect-skills/ctx.ts';
import type { DetectSkillsDeps } from '@src/application/flows/detect-skills/deps.ts';
import { proposeDetectSkillsLeaf } from '@src/application/flows/detect-skills/leaves/propose.ts';
import { confirmDetectSkillsLeaf } from '@src/application/flows/detect-skills/leaves/confirm.ts';
import { writeDetectSkillsLeaf } from '@src/application/flows/detect-skills/leaves/write.ts';

export interface CreateDetectSkillsFlowOpts {
  readonly projectId: ProjectId;
  readonly repositoryId?: RepositoryId;
  readonly model: string;
  /** Resolved effort / reasoning level — optional. */
  readonly effort?: string;
}

/**
 * Build the detect-skills chain. Mirrors detect-scripts:
 *
 *   sequential('detect-skills', [
 *     load-project,
 *     pick-repository,          // auto when ctx.repositoryId is set or project has one repo
 *     allocate-run-dir-detect-skills,  // materialises <runsRoot>/detect-skills/<run-id>/
 *     propose,                  // AI round-trip → ctx.proposal (both skills may be undefined)
 *     confirm,                  // interactive; auto-declines when proposal is empty
 *     write,                    // no-op when not accepted; updateRepository + save otherwise
 *   ])
 */
export const createDetectSkillsFlow = (
  deps: DetectSkillsDeps,
  opts: CreateDetectSkillsFlowOpts
): Element<DetectSkillsCtx> => {
  void opts.projectId;
  void opts.repositoryId;
  return sequential<DetectSkillsCtx>('detect-skills', [
    loadProjectLeaf<DetectSkillsCtx>({ projectRepo: deps.projectRepo }),
    pickRepositoryLeaf<DetectSkillsCtx>(
      { interactive: deps.interactive },
      {
        promptMessage: 'Which repository should the AI author skills for?',
        emptyVerb: 'author skills for',
        preselectedFromCtx: (ctx) => ctx.repositoryId,
      }
    ),
    allocateRunDirLeaf<DetectSkillsCtx>({
      name: 'allocate-run-dir-detect-skills',
      runsRoot: () => deps.runsRoot,
      flowSegment: 'detect-skills',
      write: (ctx, runDir) => ({ ...ctx, proposal: { ...ctx.proposal, runDir } }),
    }),
    proposeDetectSkillsLeaf({
      provider: deps.provider,
      templateLoader: deps.templateLoader,
      signals: deps.signals,
      eventBus: deps.eventBus,
      writeFile: deps.writeFile,
      logger: deps.logger,
      skillsAdapter: deps.skillsAdapter,
      model: opts.model,
      ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
    }),
    confirmDetectSkillsLeaf({ interactive: deps.interactive }),
    writeDetectSkillsLeaf({ projectRepo: deps.projectRepo, logger: deps.logger }),
  ]);
};
