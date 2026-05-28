/**
 * Pure routing decision for `launchTui`. Given the result of the side-effecting reads
 * (`settingsRepo.exists()`, `projectRepo.list()`, last-selection-store), produce the initial
 * view and an optional pre-seeded selection.
 *
 *   - No settings file yet           → welcome flow
 *   - Settings present, no projects  → create-project wizard
 *   - Settings + projects exist      → home. The persisted last-selection wins if it still
 *                                       resolves; otherwise the FIRST project is pre-seeded so
 *                                       the user lands on a populated Home instead of a "pick a
 *                                       project" card. This auto-default is in-memory only — the
 *                                       SelectionProvider's first-run guard suppresses the
 *                                       initial persistence write, so it never masquerades as a
 *                                       real user choice on the next launch. A sprint is seeded
 *                                       too: the persisted sprint when it still resolves under
 *                                       the restored project, otherwise the resolved project's
 *                                       most-recent sprint (descending UUIDv7 id).
 *
 * Pulled out so launch.ts stays a thin orchestrator and the routing logic gets a focused
 * unit test instead of a full Ink boot.
 */

import type { Project } from '@src/domain/entity/project.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { ViewEntry } from '@src/application/ui/tui/runtime/router.tsx';

export interface InitialSelection {
  readonly projectId: ProjectId;
  readonly projectLabel: string;
  /**
   * Optional pre-pinned sprint under {@link projectId}. Surfaces the
   * `LastSelection.sprintId` the user wrote via `ralphctl sprint set-current`. We hand it to
   * the selection context as a seed; SelectionProvider keeps the ids decoupled from the
   * loaded `Sprint` entity (the home view fetches that lazily).
   */
  readonly sprintId?: SprintId;
}

export interface InitialState {
  readonly initialView: ViewEntry;
  readonly initialSelection?: InitialSelection;
}

export interface InitialStateInputs {
  /** `settings.json` exists on disk. */
  readonly settingsExist: boolean;
  /** Every project the repository currently knows about. */
  readonly projects: readonly Project[];
  /** Last project the user worked on, if persisted on disk. */
  readonly lastProjectId?: ProjectId;
  /** Last sprint the user pinned under {@link lastProjectId} via `sprint set-current` (or the TUI). */
  readonly lastSprintId?: SprintId;
  /**
   * Every sprint the repository currently knows about. Used to seed the resolved project's
   * most-recent sprint when no valid persisted sprint exists, and to validate that a persisted
   * sprint still belongs to the restored project. Optional so existing callers/tests typecheck.
   */
  readonly sprints?: readonly Sprint[];
}

export const resolveInitialState = ({
  settingsExist,
  projects,
  lastProjectId,
  lastSprintId,
  sprints,
}: InitialStateInputs): InitialState => {
  if (!settingsExist) return { initialView: { id: 'welcome' } };
  const [first] = projects;
  // `first === undefined` ⇔ empty list; both routes to the create-project wizard. The guard
  // also narrows `first` to `Project` for the rest of the function (noUncheckedIndexedAccess).
  if (first === undefined) return { initialView: { id: 'create-project' } };
  // Restore the persisted project when it still resolves; otherwise default to the FIRST
  // project. The auto-default is harmless because the SelectionProvider's first-run guard
  // suppresses the initial persistence write — only post-mount selection changes hit disk, so
  // an auto-default never masquerades as a real user choice on the next launch.
  const restored = lastProjectId !== undefined ? projects.find((p) => p.id === lastProjectId) : undefined;
  const resolvedProject = restored ?? first;
  // UUIDv7 ids are timestamp-prefixed; descending lexical order is most-recent-first.
  const projectSprints = (sprints ?? [])
    .filter((s) => s.projectId === resolvedProject.id)
    .slice()
    .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  // Honour the persisted sprint only when the persisted project still resolved AND the sprint
  // still belongs to it — re-pinning a project elsewhere invalidates the previous sprint pick.
  const persistedSprintValid =
    restored !== undefined && lastSprintId !== undefined && projectSprints.some((s) => s.id === lastSprintId);
  // Seed the most-recent sprint when the persisted one is missing; undefined when the project
  // has zero sprints.
  const seededSprintId = persistedSprintValid ? lastSprintId : projectSprints[0]?.id;
  return {
    initialView: { id: 'home' },
    initialSelection: {
      projectId: resolvedProject.id,
      projectLabel: resolvedProject.displayName,
      ...(seededSprintId !== undefined ? { sprintId: seededSprintId } : {}),
    },
  };
};
