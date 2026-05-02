/**
 * `createOnboardFlow` — chain definition for AI-assisted repository
 * onboarding.
 *
 * Steps (happy path):
 *
 *   load-project → resolve-repo → detect-existing-files → run-onboard-ai →
 *     confirm-setup-script → confirm-verify-script → confirm-context-file →
 *     write-context-file → save-repo-scripts
 *
 * `detect-existing-files` probes the repo for AI-context files
 * (CLAUDE.md / .github/copilot-instructions.md / AGENTS.md) that already
 * exist *without* the ralphctl harness marker. When found, the user is
 * offered the choice to mark the repo as **externally managed** — every
 * downstream leaf (AI round-trip, three confirms, context-file write)
 * short-circuits, and `save-repo-scripts` only stamps `onboardedAt`. No
 * files are modified. This is the safe default for repos that are
 * already onboarded by another harness or hand-authored.
 *
 * Otherwise the AI round-trip runs in `run-onboard-ai`. Everything
 * before it is preflight; everything after is review + persistence. The
 * user can edit each artefact independently.
 *
 * `autoAccept: true` short-circuits the three confirm leaves to the AI's
 * proposal as-is, AND auto-accepts the externally-managed default when
 * pre-existing files are detected (used by `--auto` flag / CI).
 */
import type { Project } from '@src/domain/entities/project.ts';
import type { Repository } from '@src/domain/entities/repository.ts';
import type { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';
import type { ProjectName } from '@src/domain/values/project-name.ts';
import type { Element } from '@src/kernel/chain/element.ts';
import { Sequential } from '@src/kernel/chain/sequential.ts';
import type { OnboardRepoProposals } from '@src/business/usecases/onboard/onboard-repo.ts';
import type { ChainSharedDeps } from '@src/application/chains/chain-deps.ts';
import {
  confirmContextFileLeaf,
  confirmSetupScriptLeaf,
  confirmStartAiLeaf,
  confirmVerifyScriptLeaf,
  detectExistingFilesLeaf,
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
  /**
   * `true` when the repo was found to already contain AI-context files
   * (CLAUDE.md / copilot-instructions.md / AGENTS.md) without the
   * ralphctl harness marker AND the user opted to mark it as externally
   * managed. The chain short-circuits the AI / confirm / write leaves
   * and `save-repo-scripts` only stamps `onboardedAt`.
   */
  readonly externallyManaged?: boolean;
  /** Relative paths of pre-existing context files (for display / logging). */
  readonly existingContextFiles?: readonly string[];
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
    detectExistingFilesLeaf(deps),
    confirmStartAiLeaf(deps),
    runOnboardAiLeaf(deps),
    confirmSetupScriptLeaf(deps),
    confirmVerifyScriptLeaf(deps),
    confirmContextFileLeaf(deps),
    writeLeaf,
    saveRepoScriptsLeaf(deps, stamp),
  ]);
}
