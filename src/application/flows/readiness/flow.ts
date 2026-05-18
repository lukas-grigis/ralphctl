import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { Element } from '@src/application/chain/element.ts';
import { sequential } from '@src/application/chain/build/sequential.ts';
import { loadProjectLeaf } from '@src/application/flows/_shared/project/load.ts';
import { pickRepositoryLeaf } from '@src/application/flows/_shared/project/pick-repository.ts';
import type { ReadinessCtx } from '@src/application/flows/readiness/ctx.ts';
import type { SetupReadinessDeps } from '@src/application/flows/readiness/deps.ts';
import { confirmReadinessLeaf } from '@src/application/flows/readiness/leaves/confirm.ts';
import { pickToolLeaf } from '@src/application/flows/readiness/leaves/pick-tool.ts';
import { probeReadinessLeaf } from '@src/application/flows/readiness/leaves/probe.ts';
import { proposeReadinessLeaf } from '@src/application/flows/readiness/leaves/propose.ts';
import { writeReadinessLeaf } from '@src/application/flows/readiness/leaves/write.ts';
import { installSkillsLeaf } from '@src/application/flows/_shared/skills/install-skills.ts';
import { uninstallSkillsLeaf } from '@src/application/flows/_shared/skills/uninstall-skills.ts';

export interface CreateReadinessFlowOpts {
  readonly projectId: ProjectId;
  /**
   * Working directory passed to the AI session. Captured at chain-construction; switching
   * repositories mid-run is out of scope — one chain run sets up readiness for one repository.
   */
  readonly cwd: AbsolutePath;
  /** Configured model for the readiness chain — flows from `config.ai.<provider>.models.readiness`. */
  readonly model: string;
}

/**
 * Build the readiness chain.
 *
 * Shape:
 *
 *   sequential('readiness', [
 *     load-project,
 *     pick-repository,    // interactive (auto-selects when project has one repo)
 *     pick-tool,          // interactive
 *     probe,
 *     propose, // AI round-trip → ctx.proposal
 *     confirm, // interactive (preview + askConfirm)
 *     write,   // no-op when not accepted; backup-then-write when accepted
 *   ])
 *
 * Trace order: load-project → pick-repository → pick-tool → probe →
 * propose → confirm → write.
 */
export const createReadinessFlow = (deps: SetupReadinessDeps, opts: CreateReadinessFlowOpts): Element<ReadinessCtx> =>
  sequential<ReadinessCtx>('readiness', [
    loadProjectLeaf<ReadinessCtx>({ projectRepo: deps.projectRepo }),
    pickRepositoryLeaf<ReadinessCtx>(
      { interactive: deps.interactive },
      {
        promptMessage: 'Which repository do you want to set up readiness for?',
        emptyVerb: 'set up readiness for',
      }
    ),
    pickToolLeaf({ interactive: deps.interactive }),
    probeReadinessLeaf({ probes: deps.probes, clock: deps.clock }),
    installSkillsLeaf<ReadinessCtx>(
      { skillsAdapter: deps.skillsAdapter, skillSource: deps.skillSource },
      { flowId: 'readiness', cwdPicker: () => opts.cwd }
    ),
    proposeReadinessLeaf({
      provider: deps.provider,
      templateLoader: deps.templateLoader,
      signals: deps.signals,
      logger: deps.logger,
      cwd: opts.cwd,
      model: opts.model,
    }),
    uninstallSkillsLeaf<ReadinessCtx>({ skillsAdapter: deps.skillsAdapter }, { cwdPicker: () => opts.cwd }),
    confirmReadinessLeaf({ interactive: deps.interactive }),
    writeReadinessLeaf({ writeFile: deps.writeFile, logger: deps.logger, clock: deps.clock }),
  ]);
