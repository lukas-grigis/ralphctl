/**
 * Pure routing decision for `launchTui`. Given the result of the side-effecting reads
 * (`settingsRepo.exists()`, `projectRepo.list()`, last-selection-store), produce the initial
 * view and an optional pre-seeded selection.
 *
 *   - No settings file yet           → welcome flow
 *   - Settings present, no projects  → create-project wizard
 *   - Settings + projects exist      → home, with the persisted last-selection pre-seeded
 *                                       (falls back to the first project). The user can
 *                                       press `P` to open the picker if they want to switch.
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
  const preselected =
    (lastProjectId !== undefined ? projects.find((p) => p.id === lastProjectId) : undefined) ?? projects[0];
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
