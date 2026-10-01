/** Pure routing decision for `launchTui`. */

import type { Project } from '@src/domain/entity/project.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { ViewEntry } from '@src/application/ui/tui/runtime/router.tsx';

export interface InitialSelection {
  readonly projectId: ProjectId;
  readonly projectLabel: string;
  /**
   * Optional pre-pinned sprint under {@link projectId}. Surfaces the `LastSelection.sprintId` the user wrote via
   * `ralphctl sprint set-current`.
   */
  readonly sprintId?: SprintId;
  /**
   * Readable name of the seeded sprint, resolved from the sprints array at boot time. Prevents the breadcrumb from
   * showing a raw identifier on the first paint.
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
  /** Every sprint the repository currently knows about. Optional so existing callers/tests typecheck. */
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
  // When the persisted project doesn't resolve we must NOT auto-pick the alphabetically-first of several projects —
  // that dumps the user onto an unrelated project's empty card.
  const resolvedProject = restored ?? (projects.length === 1 ? first : undefined);
  if (resolvedProject === undefined) return { initialView: { id: 'home' } };
  // UUIDv7 ids are timestamp-prefixed; descending lexical order is most-recent-first.
  const projectSprints = (sprints ?? [])
    .filter((s) => s.projectId === resolvedProject.id)
    .slice()
    .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  // Honour the persisted sprint only when the persisted project still resolved AND the sprint still belongs to it —
  // re-pinning a project elsewhere invalidates the previous sprint pick.
  const persistedSprintValid =
    restored !== undefined && lastSprintId !== undefined && projectSprints.some((s) => s.id === lastSprintId);
  // Seed the most-recent NON-`done` sprint when the persisted one is missing, so the user lands
  // on actionable work rather than a sealed sprint; undefined when the project has no open sprint.
  const seededSprintId = persistedSprintValid ? lastSprintId : projectSprints.find((s) => s.status !== 'done')?.id;
  // Resolve the readable name so the breadcrumb shows it immediately on first paint.
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
