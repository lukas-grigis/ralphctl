/**
 * Pure routing decision for `launchTui`. Given the result of the side-effecting reads
 * (`settingsRepo.exists()`, `projectRepo.list()`, last-selection-store), produce the initial
 * view and an optional pre-seeded selection.
 *
 *   - No settings file yet           → welcome flow
 *   - Settings present, no projects  → create-project wizard
 *   - Settings + projects exist      → home. The persisted last-selection wins if it still
 *                                       resolves. When it does NOT resolve we never auto-pick the
 *                                       alphabetically-first of several projects (that dumps the
 *                                       user onto an unrelated project's empty card): if exactly
 *                                       ONE project exists it is pre-seeded; with MULTIPLE
 *                                       projects we return Home with NO selection so the StateCard
 *                                       shows the "pick a project" prompt. A seeded project gets a
 *                                       sprint too: the persisted sprint when it still resolves
 *                                       under that project (even if `done` — the done-on-boot probe
 *                                       in SelectionProvider clears it to the empty-sprint card),
 *                                       otherwise the project's most-recent NON-`done` sprint
 *                                       (descending UUIDv7 id) so the user lands on actionable
 *                                       work, otherwise no sprint.
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
  /**
   * Readable name of the seeded sprint, resolved from the sprints array at boot time.
   * Absent when no sprint is seeded or when the sprint can no longer be found (removed).
   * Prevents the breadcrumb from showing a raw identifier on the first paint.
   */
  readonly sprintLabel?: string;
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
  // Restore the persisted project when it still resolves.
  const restored = lastProjectId !== undefined ? projects.find((p) => p.id === lastProjectId) : undefined;
  // When the persisted project doesn't resolve we must NOT auto-pick the alphabetically-first of
  // several projects — that dumps the user onto an unrelated project's empty card. Single-project
  // is unambiguous (seed it); multiple projects → Home with no selection so the StateCard prompts
  // the user to pick.
  const resolvedProject = restored ?? (projects.length === 1 ? first : undefined);
  if (resolvedProject === undefined) return { initialView: { id: 'home' } };
  // UUIDv7 ids are timestamp-prefixed; descending lexical order is most-recent-first.
  const projectSprints = (sprints ?? [])
    .filter((s) => s.projectId === resolvedProject.id)
    .slice()
    .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  // Honour the persisted sprint only when the persisted project still resolved AND the sprint
  // still belongs to it — re-pinning a project elsewhere invalidates the previous sprint pick.
  // The persisted sprint wins even when `done`; the done-on-boot probe in SelectionProvider
  // clears it to the empty-sprint card.
  const persistedSprintValid =
    restored !== undefined && lastSprintId !== undefined && projectSprints.some((s) => s.id === lastSprintId);
  // Seed the most-recent NON-`done` sprint when the persisted one is missing, so the user lands
  // on actionable work rather than a sealed sprint; undefined when the project has no open sprint.
  const seededSprintId = persistedSprintValid ? lastSprintId : projectSprints.find((s) => s.status !== 'done')?.id;
  // Resolve the readable name so the breadcrumb shows it immediately on first paint.
  // Falls back to absent (no label) when the sprint can no longer be found.
  const seededSprint = seededSprintId !== undefined ? projectSprints.find((s) => s.id === seededSprintId) : undefined;
  return {
    initialView: { id: 'home' },
    initialSelection: {
      projectId: resolvedProject.id,
      projectLabel: resolvedProject.displayName,
      ...(seededSprintId !== undefined ? { sprintId: seededSprintId } : {}),
      ...(seededSprint !== undefined ? { sprintLabel: seededSprint.name } : {}),
    },
  };
};
