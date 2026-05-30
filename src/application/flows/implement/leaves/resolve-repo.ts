import type { Task } from '@src/domain/entity/task.ts';
import type { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';

/**
 * Per-repository execution config — path + the scripts the chain runs against that repo. The
 * launcher builds this map from `Project.repositories` (one entry per registered repo). Re-exported
 * from `flow.ts` as part of the implement chain's public construction API.
 */
export interface RepoExecConfig {
  readonly path: AbsolutePath;
  /**
   * Human-friendly repository name (the repo's `Repository.name`, not its path). Carried so the
   * per-task leaves that persist repo-attributed artefacts (the Theme 6 learnings ledger via
   * `append-learnings`) record a readable `repoName` alongside the absolute `path`.
   */
  readonly name: string;
  readonly verifyScript?: string;
  readonly setupScript?: string;
}

/**
 * Lookup helper — resolves a task's `repositoryId` against the launcher-provided map. A task that
 * references an unknown repo id is a planning bug — fail loudly at chain construction rather than
 * mid-run with a confusing "missing cwd" surface.
 *
 * Throws `InvalidStateError` (programmer-error path) rather than returning a Result because the
 * caller is the chain factory itself, not a use case — there's no Result-shaped seam to thread the
 * error through, and the throw is caught by the runner one frame up.
 */
export const resolveRepoOrThrow = (
  repositories: ReadonlyMap<RepositoryId, RepoExecConfig>,
  task: Task
): RepoExecConfig => {
  const repo = repositories.get(task.repositoryId);
  if (repo === undefined) {
    throw new InvalidStateError({
      entity: 'task',
      currentState: 'pre-implement',
      attemptedAction: 'resolve-repo',
      message: `task '${String(task.id)}' references repositoryId '${String(task.repositoryId)}' which is not in the project's repositories`,
    });
  }
  return repo;
};
