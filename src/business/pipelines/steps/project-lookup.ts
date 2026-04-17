/**
 * Shared project / check-script resolution for per-task pipeline steps.
 *
 * Post-repoId migration: tasks carry `repoId` (not `projectPath`). Lookup
 * is by id — one direct call to `persistence.getRepoById` returns the
 * owning project + repo. The old path-based helpers are gone; callers
 * that need an absolute path go through `persistence.resolveRepoPath`.
 */

import type { Project, Repository } from '@src/domain/models.ts';
import type { PersistencePort } from '@src/business/ports/persistence.ts';

/**
 * Resolve a repoId to its owning project + repo. Returns `undefined` when
 * no match — matches the silent-fallthrough behaviour the pre-id code had.
 */
export async function findProjectForRepoId(
  persistence: PersistencePort,
  repoId: string
): Promise<{ project: Project; repo: Repository } | undefined> {
  try {
    return await persistence.getRepoById(repoId);
  } catch {
    return undefined;
  }
}

/** Resolve a repo's `checkScript`, or null when none is configured. */
export function resolveCheckScriptForRepo(repo: Repository | undefined): string | null {
  return repo?.checkScript ?? null;
}
