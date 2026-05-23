/**
 * Pure routing decision for `launchTui`. Given the result of the side-effecting reads
 * (`settingsRepo.exists()`, `projectRepo.list()`, last-selection-store), produce the initial
 * view and an optional pre-seeded selection.
 *
 *   - No settings file yet           → welcome flow
 *   - Settings present, no projects  → create-project wizard
 *   - Settings + projects exist      → home. The persisted last-selection wins if it still
 *                                       resolves; otherwise the only project (when there's
 *                                       exactly one) is pre-seeded so single-project users
 *                                       skip the picker. With multiple projects and no
 *                                       persisted choice, no selection is seeded — Home
 *                                       renders the "pick a project to work on" card and
 *                                       nothing gets written to disk until the user picks.
 *
 * Pulled out so launch.ts stays a thin orchestrator and the routing logic gets a focused
 * unit test instead of a full Ink boot.
 */

import type { Project } from '@src/domain/entity/project.ts';
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
}

export const resolveInitialState = ({
  settingsExist,
  projects,
  lastProjectId,
  lastSprintId,
}: InitialStateInputs): InitialState => {
  if (!settingsExist) return { initialView: { id: 'welcome' } };
  if (projects.length === 0) return { initialView: { id: 'create-project' } };
  // Restore the persisted project when it still resolves. Otherwise pre-seed only the
  // single-project case (no real choice to make). Picking projects[0] arbitrarily would get
  // persisted on first render and masquerade as a user choice on every subsequent launch.
  const restored = lastProjectId !== undefined ? projects.find((p) => p.id === lastProjectId) : undefined;
  const preselected = restored ?? (projects.length === 1 ? projects[0] : undefined);
  if (preselected === undefined) return { initialView: { id: 'home' } };
  // Only thread sprintId through when the pinned project still matches — re-pinning a project
  // elsewhere invalidates the previous sprint pick.
  const carrySprintId = lastSprintId !== undefined && preselected.id === lastProjectId ? lastSprintId : undefined;
  return {
    initialView: { id: 'home' },
    initialSelection: {
      projectId: preselected.id,
      projectLabel: preselected.displayName,
      ...(carrySprintId !== undefined ? { sprintId: carrySprintId } : {}),
    },
  };
};
