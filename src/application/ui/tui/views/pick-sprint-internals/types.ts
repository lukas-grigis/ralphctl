/**
 * Pick-sprint internals — shared row + grouping types.
 *
 * `FlatRow` is the cursor-navigable row in the picker; `SprintGroup` is the
 * pre-flatten grouping. `PickerData` is the raw loaded snapshot the picker
 * reduces over. Kept here so the orchestrator, the row builders, and the row
 * renderers all reference one source of truth without circular imports.
 */

import type { Project } from '@src/domain/entity/project.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';

export const UNKNOWN_PROJECT_KEY = '__unknown__';
export const UNKNOWN_PROJECT_LABEL = 'Unknown project';

export interface PickerData {
  readonly sprints: readonly Sprint[];
  readonly projectsById: ReadonlyMap<ProjectId, Project>;
}

export interface HeaderRow {
  readonly kind: 'header';
  readonly groupKey: string;
  readonly label: string;
  readonly orphan: boolean;
  readonly empty: boolean;
}

export interface SprintRow {
  readonly kind: 'sprint';
  readonly groupKey: string;
  readonly sprint: Sprint;
}

/**
 * Synthetic top row that routes through the create-sprint flow. Sits above the project groups
 * so the user can launch creation without scrolling past every existing sprint, and so an
 * "empty-storage" picker (no sprints anywhere yet) still surfaces a productive action.
 */
export interface CreateActionRow {
  readonly kind: 'create';
}

export type FlatRow = HeaderRow | SprintRow | CreateActionRow;

export interface SprintGroup {
  readonly key: string;
  readonly label: string;
  readonly orphan: boolean;
  readonly sprints: readonly Sprint[];
}
