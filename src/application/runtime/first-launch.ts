/**
 * `isFirstLaunch` — pure detector for the no-data boot path.
 *
 * Returns `true` when the user has not yet registered a project AND does
 * not have a current sprint pointer. Both conditions matter:
 *  - A returning user with at least one project but no sprint is not on
 *    a first launch — they're between sprints.
 *  - A user with `currentSprint` set but no projects has done something
 *    weird (manually edited config) and shouldn't be force-routed back
 *    to onboarding.
 *
 * Used by:
 *  - The TUI mount path to push the `'project-add'` view directly.
 *  - The CLI entrypoint to print a friendly message in non-TTY mode.
 */
import type { ConfigStorePort } from '../config/config-store-port.ts';
import type { ProjectRepository } from '../../domain/repositories/project-repository.ts';

export interface FirstLaunchDeps {
  readonly projectRepo: ProjectRepository;
  readonly configStore: ConfigStorePort;
}

export async function isFirstLaunch(deps: FirstLaunchDeps): Promise<boolean> {
  const projects = await deps.projectRepo.list();
  if (!projects.ok) return false;
  if (projects.value.length > 0) return false;

  const config = await deps.configStore.load();
  if (!config.ok) return false;
  if (config.value.currentSprint !== null) return false;

  return true;
}
