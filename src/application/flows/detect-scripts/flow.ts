import type { Element } from '@src/application/chain/element.ts';
import { sequential } from '@src/application/chain/build/sequential.ts';
import { loadProjectLeaf } from '@src/application/flows/_shared/project/load.ts';
import { pickRepositoryLeaf } from '@src/application/flows/_shared/project/pick-repository.ts';
import { allocateRunDirLeaf } from '@src/application/flows/_shared/allocate-run-dir.ts';
import { createPublishSignal } from '@src/application/flows/_shared/publish-signal.ts';
import type { DetectScriptsCtx } from '@src/application/flows/detect-scripts/ctx.ts';
import type { DetectScriptsDeps } from '@src/application/flows/detect-scripts/deps.ts';
import { proposeDetectScriptsLeaf } from '@src/application/flows/detect-scripts/leaves/propose.ts';
import { confirmDetectScriptsLeaf } from '@src/application/flows/detect-scripts/leaves/confirm.ts';
import { writeDetectScriptsLeaf } from '@src/application/flows/detect-scripts/leaves/write.ts';

export interface CreateDetectScriptsFlowOpts {
  /** Model id from `settings.ai.readiness.model` — the same read-only inventory tier. */
  readonly model: string;
  /** Resolved effort / reasoning level — optional. */
  readonly effort?: string;
}

/** Canonical flow id — the sequential trace name, the run-dir segment, and the signal source. */
const DETECT_SCRIPTS_FLOW = 'detect-scripts';

/**
 * AI inventory of one repository's setup / verify scripts, confirmed by the operator before it is
 * saved. `ctx.repositoryId` preselects the repository.
 */
export const createDetectScriptsFlow = (
  deps: DetectScriptsDeps,
  opts: CreateDetectScriptsFlowOpts
): Element<DetectScriptsCtx> => {
  return sequential<DetectScriptsCtx>(DETECT_SCRIPTS_FLOW, [
    loadProjectLeaf<DetectScriptsCtx>({ projectRepo: deps.projectRepo }),
    pickRepositoryLeaf<DetectScriptsCtx>(
      { interactive: deps.interactive },
      {
        promptMessage: 'Which repository should the AI inventory?',
        emptyVerb: 'inventory',
        preselectedFromCtx: (ctx) => ctx.repositoryId,
      }
    ),
    allocateRunDirLeaf<DetectScriptsCtx>({
      name: 'allocate-run-dir-detect-scripts',
      runsRoot: () => deps.runsRoot,
      flowSegment: DETECT_SCRIPTS_FLOW,
      write: (ctx, runDir) => ({ ...ctx, proposal: { ...ctx.proposal, runDir } }),
    }),
    proposeDetectScriptsLeaf({
      provider: deps.provider,
      templateLoader: deps.templateLoader,
      publishSignal: createPublishSignal(deps.eventBus, DETECT_SCRIPTS_FLOW),
      logger: deps.logger,
      model: opts.model,
      ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
    }),
    confirmDetectScriptsLeaf({ interactive: deps.interactive }),
    writeDetectScriptsLeaf({ projectRepo: deps.projectRepo, logger: deps.logger }),
  ]);
};
