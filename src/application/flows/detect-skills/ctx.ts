import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { Repository } from '@src/domain/entity/repository.ts';
import type { RepositoryId } from '@src/domain/value/id/repository-id.ts';

/**
 * Context flowing through the detect-skills chain. Mirrors {@link DetectScriptsCtx} — the two
 * flows share the same shape of work (read-only AI inventory of one repo → propose → confirm →
 * write back to the Repository entity) but produce different artifacts: scripts are single
 * shell lines, skills are multi-paragraph markdown bodies.
 */
export interface DetectSkillsCtx {
  readonly projectId: ProjectId;
  readonly repositoryId?: RepositoryId;
  readonly project?: Project;
  readonly repository?: Repository;
  readonly proposal?: {
    /**
     * AI-authored markdown body for the setup skill (multi-paragraph). Undefined when the AI
     * omitted the `<setup-skill>` tag because no stack-specific guidance is warranted. Maps
     * to `Repository.setupSkill` on accept.
     */
    readonly proposedSetupSkill?: string;
    /**
     * AI-authored markdown body for the verify skill. Maps to `Repository.verifySkill` on
     * accept. Either or both may be undefined.
     */
    readonly proposedVerifySkill?: string;
    /**
     * Per-run forensic dir under `<dataRoot>/runs/detect-skills/<run-id>/` holding the
     * rendered `prompt.md` and (for Claude) the raw `body.txt`. Stamped by the
     * `allocate-run-dir-detect-skills` leaf BEFORE propose runs (so propose reads it back off
     * ctx rather than allocating it itself), then carried forward unchanged so the confirm
     * leaf can show the user the AI's actual response when a proposal comes back empty.
     */
    readonly runDir?: AbsolutePath;
  };
  readonly accepted?: boolean;
}
