import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { Repository } from '@src/domain/entity/repository.ts';
import type { RepositoryId } from '@src/domain/value/id/repository-id.ts';

/**
 * Context flowing through the detect-scripts chain.
 *
 * Inputs supplied at chain construction:
 *  - `projectId` — the project that owns the repository to inventory.
 *  - `repositoryId` — optional pre-selection. When the user launches detection from the
 *    project-detail view on a specific row, the launcher sets this and `pickRepositoryLeaf`
 *    auto-resolves; when unset (launched from the flow menu), the leaf prompts.
 *
 * Slots populated by upstream leaves:
 *  - `project`    — by `loadProjectLeaf`.
 *  - `repository` — by `pickRepositoryLeaf`.
 *  - `proposal`   — by `proposeDetectScriptsLeaf` (AI round-trip + parse).
 *  - `accepted`   — by `confirmDetectScriptsLeaf` (askConfirm against the proposal preview).
 *
 * `accepted: false` short-circuits the write leaf, leaving the repository entity untouched.
 */
export interface DetectScriptsCtx {
  readonly projectId: ProjectId;
  readonly repositoryId?: RepositoryId;
  readonly project?: Project;
  readonly repository?: Repository;
  readonly proposal?: {
    /**
     * AI-suggested setup script (one shell line, e.g. `pnpm install`). Undefined when the AI
     * omitted the `<setup-script>` tag because no setup is needed. Maps to
     * `Repository.setupScript` on accept.
     */
    readonly proposedSetupScript?: string;
    /**
     * AI-suggested verify script (one shell line chaining typecheck / lint / test with `&&`).
     * Undefined when the project exposes no such commands. Maps to `Repository.verifyScript`
     * on accept — the harness's post-task gate.
     */
    readonly proposedVerifyScript?: string;
    /**
     * Per-run forensic dir under `<dataRoot>/runs/detect-scripts/<run-id>/` holding the
     * rendered `prompt.md` and (for providers that implement `bodyFile`, i.e. Claude today)
     * the raw `body.txt`. Surfaced to the confirm leaf so an empty proposal can show the user
     * what the AI actually emitted instead of leaving them with no context.
     */
    readonly runDir?: AbsolutePath;
  };
  readonly accepted?: boolean;
}
