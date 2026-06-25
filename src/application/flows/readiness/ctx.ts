import type { ReadinessState } from '@src/integration/ai/readiness/_engine/state.ts';
import type { AssistantTool } from '@src/integration/ai/readiness/_engine/tool.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import type { Repository } from '@src/domain/entity/repository.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';

/**
 * Per-tool slot the readiness chain accumulates as each tool's sub-chain runs. One entry per
 * {@link AssistantTool} in `ctx.tools`. The slots fill in order — probe lands `probedState`,
 * propose lands `proposal`, confirm lands `accepted`. Downstream leaves read the same slot for
 * the tool they're scoped to.
 */
export interface ReadinessToolEntry {
  readonly probedState?: ReadinessState;
  /**
   * Pre-allocated per-tool run directory under `<runsRoot>/readiness/<run-id>/`. Stamped by
   * the `allocate-run-dir-<tool>` leaf BEFORE the propose leaf so the per-spawn `meta.json`
   * sidecar can land beside the AI-written `signals.json`. Threaded into the propose leaf
   * (via input projection) so the AI session's `outputDir` matches this dir exactly.
   */
  readonly runDir?: AbsolutePath;
  readonly proposal?: {
    readonly proposedContent: string;
    readonly targetPath: AbsolutePath;
    /**
     * AI-suggested setup script (one shell line, e.g. `pnpm install`). Undefined when the AI
     * omitted the `<setup-script>` tag because no setup is needed.
     */
    readonly proposedSetupScript?: string;
    /**
     * AI-suggested verify script (one shell line chaining typecheck / lint / test with `&&`).
     * Undefined when the project exposes none of those.
     */
    readonly proposedVerifyScript?: string;
    /**
     * AI-authored setup skill body — multi-paragraph markdown the install leaf lands at
     * `<repo>/<parentDir>/skills/setup/SKILL.md` via the skills adapter's bare-name install
     * path.
     */
    readonly proposedSetupSkillBody?: string;
    /**
     * Same shape as {@link proposedSetupSkillBody} but for verify. Lands at
     * `<repo>/<parentDir>/skills/verify/SKILL.md`.
     */
    readonly proposedVerifySkillBody?: string;
    /**
     * Kebab-case skill names the AI suggested linking into the repo (from the optional
     * `skill-suggestions` signal). Undefined when the AI emitted none. The
     * `offer-skill-suggestions` leaf reads this slot and human-gates each suggestion into an
     * installed bundled skill or a scaffolded stub.
     */
    readonly proposedSkillSuggestions?: readonly string[];
  };
  readonly accepted?: boolean;
}

/**
 * Context flowing through the readiness chain.
 *
 * Inputs supplied at chain construction:
 *  - `projectId`    — the project whose repo is having readiness set up.
 *  - `repositoryId` — optional pre-selection. When the operator picked a repository at the
 *                     pre-launch picker, the launcher threads it here and `pickRepositoryLeaf`
 *                     auto-resolves; when unset, the leaf auto-selects a single-repo project or
 *                     prompts on a multi-repo one.
 *  - `tools`        — the unique {@link AssistantTool} set derived from `settings.ai`'s per-flow
 *                     provider rows. The chain iterates this list, running one per-tool sub-chain
 *                     per entry (probe → install-skills → propose → uninstall-skills → confirm →
 *                     write → offer-skill-suggestions → install-readiness-skills).
 *
 * Slots populated by upstream leaves:
 *  - `project`    — by `loadProjectLeaf`.
 *  - `repository` — by `pickRepositoryLeaf` (interactive choice over `project.repositories`).
 *  - `entries`    — per-tool sub-chains write into `entries[tool]` as they run.
 */
export interface ReadinessCtx {
  readonly projectId: ProjectId;
  readonly repositoryId?: RepositoryId;
  readonly project?: Project;
  readonly repository?: Repository;
  readonly tools: readonly AssistantTool[];
  readonly entries: Readonly<Partial<Record<AssistantTool, ReadinessToolEntry>>>;
}
