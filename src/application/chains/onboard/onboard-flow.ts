/**
 * `createOnboardFlow` — chain definition for AI-assisted repository
 * onboarding.
 *
 * Steps (happy path):
 *
 *   load-project → resolve-repo → run-onboard-ai →
 *     confirm-setup-script → confirm-verify-script → confirm-context-file →
 *     write-context-file → save-repo-scripts
 *
 * The single AI round-trip happens in `run-onboard-ai`. Everything before
 * it is preflight (load project, pick repo); everything after is review +
 * persistence. The user can edit each artefact independently — accepting
 * the verify script while skipping the context file is a supported path.
 *
 * `autoAccept: true` short-circuits the three confirm leaves to the AI's
 * proposal as-is (used by `--auto` flag and CI integration).
 */
import type { Project } from '../../../domain/entities/project.ts';
import type { Repository } from '../../../domain/entities/repository.ts';
import type { AbsolutePath } from '../../../domain/values/absolute-path.ts';
import { IsoTimestamp } from '../../../domain/values/iso-timestamp.ts';
import type { ProjectName } from '../../../domain/values/project-name.ts';
import type { Element } from '../../../kernel/chain/element.ts';
import { Sequential } from '../../../kernel/chain/sequential.ts';
import type { OnboardRepoProposals } from '../../../business/usecases/onboard/onboard-repo.ts';
import type { ChainSharedDeps } from '../chain-deps.ts';
import {
  confirmContextFileLeaf,
  confirmSetupScriptLeaf,
  confirmVerifyScriptLeaf,
  loadProjectLeaf,
  resolveRepoLeaf,
  runOnboardAiLeaf,
  saveRepoScriptsLeaf,
  writeContextFileLeaf,
} from './leaves.ts';

/**
 * Chain context for the onboard flow. Inputs come from the launcher;
 * fields populated as the chain runs are optional until the leaf that
 * sets them has executed.
 */
export interface OnboardCtx {
  readonly projectName: ProjectName;
  /**
   * Optional repo selection — required when the project has more than
   * one repository. Match is by exact path equality.
   */
  readonly repoPath?: AbsolutePath;
  /** When true, skip the three confirm leaves and accept the AI proposal as-is. */
  readonly autoAccept: boolean;
  // populated as the chain runs
  readonly project?: Project;
  readonly repo?: Repository;
  readonly cwd?: AbsolutePath;
  readonly proposals?: OnboardRepoProposals;
  /**
   * Three-state acceptance:
   *  - `string` — accept this value (overrides proposal)
   *  - `null`   — explicitly skip / clear
   *  - `undefined` — not yet decided (initial state)
   */
  readonly acceptedSetupScript?: string | null;
  readonly acceptedVerifyScript?: string | null;
  readonly acceptedContextFile?: string | null;
}

export interface CreateOnboardFlowOpts {
  readonly projectName: ProjectName;
  readonly repoPath?: AbsolutePath;
  readonly autoAccept?: boolean;
  /**
   * Injectable clock for `write-context-file`'s harness marker. Defaults
   * to `Date.now()` via `() => new Date()` — tests pin it for stable
   * assertions on the marker line.
   */
  readonly now?: () => Date;
}

export function createOnboardFlow(
  deps: Pick<ChainSharedDeps, 'projectRepo' | 'aiSession' | 'prompts' | 'signalParser' | 'logger' | 'prompt'>,
  opts: CreateOnboardFlowOpts
): Element<OnboardCtx> {
  const clock = opts.now;
  const writeLeaf = clock !== undefined ? writeContextFileLeaf(clock) : writeContextFileLeaf();
  // Reuse the same injected clock for the onboardedAt stamp so tests can pin
  // both timestamps to the same frozen value.
  const stamp: () => IsoTimestamp =
    clock !== undefined ? () => IsoTimestamp.fromDate(clock()) : () => IsoTimestamp.now();
  return new Sequential<OnboardCtx>('onboard', [
    loadProjectLeaf(deps),
    resolveRepoLeaf(),
    runOnboardAiLeaf(deps),
    confirmSetupScriptLeaf(deps),
    confirmVerifyScriptLeaf(deps),
    confirmContextFileLeaf(deps),
    writeLeaf,
    saveRepoScriptsLeaf(deps, stamp),
  ]);
}
