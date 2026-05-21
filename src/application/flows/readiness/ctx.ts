import type { ReadinessState } from '@src/integration/ai/readiness/_engine/state.ts';
import type { AssistantTool } from '@src/integration/ai/readiness/_engine/tool.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { Repository } from '@src/domain/entity/repository.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';

/**
 * Context flowing through the readiness chain.
 *
 * Inputs supplied at chain construction:
 *  - `projectId` — the project whose repo is having readiness set up.
 *
 * Slots populated by upstream leaves:
 *  - `project`       — by `loadProjectLeaf`.
 *  - `repository`    — by `pickRepositoryLeaf` (interactive choice over `project.repositories`).
 *  - `tool`          — by `pickToolLeaf` (interactive choice from the AssistantTool union).
 *  - `probedState`   — by `probeReadinessLeaf` (calls `evaluateReadiness`).
 *  - `proposal`      — by `proposeReadinessLeaf` (the AI round-trip + parse).
 *  - `accepted`      — by `confirmReadinessLeaf` (askConfirm against the proposal preview).
 *
 * `accepted: false` short-circuits the write leaf, leaving the working tree untouched. The
 * trace still records the confirm step so the user (and the harness logs) see exactly why no
 * file was written.
 */
export interface ReadinessCtx {
  readonly projectId: ProjectId;
  readonly project?: Project;
  readonly repository?: Repository;
  readonly tool?: AssistantTool;
  readonly probedState?: ReadinessState;
  readonly proposal?: {
    readonly proposedContent: string;
    readonly targetPath: AbsolutePath;
    /**
     * AI-suggested setup script (one shell line, e.g. `pnpm install`). Undefined when the AI
     * omitted the `<setup-script>` tag because no setup is needed. The harness uses this to
     * prepare the working tree at sprint start; downstream wiring lands it on
     * `Repository.setupScript`.
     */
    readonly proposedSetupScript?: string;
    /**
     * AI-suggested verify script (one shell line chaining typecheck / lint / test with `&&`).
     * Undefined when the project exposes none of those. Downstream wiring lands it on
     * `Repository.verifyScript` — the harness's post-task gate.
     */
    readonly proposedVerifyScript?: string;
  };
  readonly accepted?: boolean;
}
