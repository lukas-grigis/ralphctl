/**
 * Shared project / check-script resolution for per-task pipeline steps.
 *
 * `run-check-scripts` and `contract-negotiate` both need to walk a sprint's
 * tickets to find the project that owns a given `projectPath`, then pull
 * the repo's optional `checkScript`. Extracted here so the logic lives in
 * one place — changing the resolution rule (e.g. de-duping tickets with
 * the same project) updates both call sites.
 */

import type { Project, Sprint } from '@src/domain/models.ts';
import type { PersistencePort } from '@src/business/ports/persistence.ts';

/**
 * Walk the sprint's tickets, return the first project whose repositories
 * include `projectPath`. Lookup failures are swallowed — matches the
 * silent-fallthrough behaviour the pre-pipeline code had.
 */
export async function findProjectForPath(
  persistence: PersistencePort,
  sprint: Sprint,
  projectPath: string
): Promise<Project | undefined> {
  for (const ticket of sprint.tickets) {
    try {
      const project = await persistence.getProject(ticket.projectName);
      if (project.repositories.some((r) => r.path === projectPath)) return project;
    } catch {
      // Silent fallthrough — absent projects, wrong names, etc. fall out here.
    }
  }
  return undefined;
}

/** Resolve a project's `checkScript` for a given `projectPath`, or null. */
export function resolveCheckScript(project: Project | undefined, projectPath: string): string | null {
  if (!project) return null;
  const repo = project.repositories.find((r) => r.path === projectPath);
  return repo?.checkScript ?? null;
}
