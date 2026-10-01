/**
 * Context-switcher internals — shared row + grouping types.
 *
 * `FlatRow` is the cursor-navigable row in the switcher; `SprintGroup` is the pre-flatten
 * grouping. `PickerData` is the raw loaded snapshot the switcher reduces over. Kept here so the
 * orchestrator, the row builders, and the row renderers all reference one source of truth without
 * circular imports.
 */

import type { Project } from '@src/domain/entity/project.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { TaskHealthCounts } from '@src/application/ui/shared/state-snapshot.ts';

export const UNKNOWN_PROJECT_KEY = '__unknown__';
export const UNKNOWN_PROJECT_LABEL = 'Unknown project';

export interface PickerData {
  readonly sprints: readonly Sprint[];
  readonly projectsById: ReadonlyMap<ProjectId, Project>;
  /**
   * Task-blocked health per sprint, loaded once alongside `sprints` (a single batched fetch in
   * the picker's own loader) — never per rendered row, which would re-fetch on every scroll and
   * could stall the picker on a project with many sprints. Absent entry (a sprint id with no map
   * key) reads as zero counts, never as "unknown."
   */
  readonly taskHealthBySprintId: ReadonlyMap<SprintId, TaskHealthCounts>;
}

/**
 * A project's header. Selectable (`↵` switches the project and clears the sprint) unless the group
 * is the orphan bucket — sprints whose project was deleted have no project to switch to.
 */
export interface HeaderRow {
  readonly kind: 'header';
  readonly groupKey: string;
  readonly label: string;
  readonly orphan: boolean;
  readonly empty: boolean;
  /** Absent for the orphan bucket. */
  readonly projectId: ProjectId | undefined;
  readonly repoCount: number;
}

export interface SprintRow {
  readonly kind: 'sprint';
  readonly groupKey: string;
  readonly sprint: Sprint;
}

/**
 * Synthetic top row that launches the create-sprint flow. Sits above the project groups
 * so the user can launch creation without scrolling past every existing sprint, and so an
 * "empty-storage" picker (no sprints anywhere yet) still surfaces a productive action.
 */
export interface CreateActionRow {
  readonly kind: 'create';
}

/** Synthetic row that opens the create-project wizard; always offered, since a project needs no context. */
export interface CreateProjectActionRow {
  readonly kind: 'create-project';
}

export type FlatRow = HeaderRow | SprintRow | CreateActionRow | CreateProjectActionRow;

/** Rows the cursor can land on: the create actions, sprints, and any non-orphan project header. */
export type CursorRow = FlatRow;

export interface SprintGroup {
  readonly key: string;
  readonly label: string;
  readonly orphan: boolean;
  readonly projectId: ProjectId | undefined;
  readonly repoCount: number;
  readonly sprints: readonly Sprint[];
}
