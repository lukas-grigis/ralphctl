import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import type { Element } from '@src/application/chain/element.ts';
import { sequential } from '@src/application/chain/build/sequential.ts';
import { loadProjectLeaf } from '@src/application/flows/_shared/project/load.ts';
import { pickRepositoryLeaf } from '@src/application/flows/_shared/project/pick-repository.ts';
import type { DetectScriptsCtx } from '@src/application/flows/detect-scripts/ctx.ts';
import type { DetectScriptsDeps } from '@src/application/flows/detect-scripts/deps.ts';
import { proposeDetectScriptsLeaf } from '@src/application/flows/detect-scripts/leaves/propose.ts';
import { confirmDetectScriptsLeaf } from '@src/application/flows/detect-scripts/leaves/confirm.ts';
import { writeDetectScriptsLeaf } from '@src/application/flows/detect-scripts/leaves/write.ts';

export interface CreateDetectScriptsFlowOpts {
  readonly projectId: ProjectId;
  /**
   * Optional pre-selected repository. When supplied (e.g. the user launched detect-scripts
   * from a specific row on the project-detail view), `pickRepositoryLeaf` auto-resolves
   * without prompting; when omitted, it asks interactively.
   */
  readonly repositoryId?: RepositoryId;
  /** Model id from `settings.ai.readiness.model` — the same read-only inventory tier. */
  readonly model: string;
  /** Resolved effort / reasoning level — optional. */
  readonly effort?: string;
}

/**
 * Build the detect-scripts chain.
 *
 * Shape:
 *
 *   sequential('detect-scripts', [
 *     load-project,
 *     pick-repository,   // auto when ctx.repositoryId is set or project has one repo
 *     propose,           // AI round-trip → ctx.proposal (both scripts may be undefined)
 *     confirm,           // interactive; auto-declines when proposal is empty
 *     write,             // no-op when not accepted; updateRepository + save otherwise
 *   ])
 */
export const createDetectScriptsFlow = (
  deps: DetectScriptsDeps,
  opts: CreateDetectScriptsFlowOpts
): Element<DetectScriptsCtx> => {
  void opts.projectId;
  return sequential<DetectScriptsCtx>('detect-scripts', [
    loadProjectLeaf<DetectScriptsCtx>({ projectRepo: deps.projectRepo }),
    pickRepositoryLeaf<DetectScriptsCtx>(
      { interactive: deps.interactive },
      {
        promptMessage: 'Which repository should the AI inventory?',
        emptyVerb: 'inventory',
        preselectedFromCtx: (ctx) => ctx.repositoryId,
      }
    ),
    proposeDetectScriptsLeaf({
      provider: deps.provider,
      templateLoader: deps.templateLoader,
      signals: deps.signals,
      eventBus: deps.eventBus,
      logger: deps.logger,
      model: opts.model,
      ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
      runsRoot: deps.runsRoot,
    }),
    confirmDetectScriptsLeaf({ interactive: deps.interactive }),
    writeDetectScriptsLeaf({ projectRepo: deps.projectRepo, logger: deps.logger }),
  ]);
};
