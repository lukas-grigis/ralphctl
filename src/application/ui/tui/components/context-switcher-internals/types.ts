/**
 * Context-switcher internals — shared row + grouping types. `FlatRow` is the cursor-navigable row in the switcher;
 * `SprintGroup` is the pre-flatten grouping.
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
   * Task-blocked health per sprint, loaded once alongside `sprints` (a single batched fetch in the picker's own
   * loader) — never per rendered row.
   */
  readonly taskHealthBySprintId: ReadonlyMap<SprintId, TaskHealthCounts>;
}

/** A project's header. */
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

/** Synthetic top row that launches the create-sprint flow. */
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
