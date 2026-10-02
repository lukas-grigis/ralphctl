/**
 * Pure list-shaping helpers for the sprint picker: bucket sprints into project groups, flatten
 * the groups into the cursor-navigable row list, and derive the id-keyed cursorable subset that
 * feeds the shared `useListWindow` primitive. Headers are never cursor targets.
 */

import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import {
  type CreateActionRow,
  type FlatRow,
  type PickerData,
  type SprintGroup,
  type SprintRow,
  UNKNOWN_PROJECT_KEY,
  UNKNOWN_PROJECT_LABEL,
} from '@src/application/ui/tui/views/pick-sprint-internals/types.ts';

/**
 * Build the grouped + sorted list of sprint groups.
 *
 * Ordering:
 *  - Current project first (when known and non-empty / present in projects).
 *  - Then alphabetical by displayName.
 *  - Within each group: newest first (UUIDv7 lex sort, reversed).
 *  - Orphan "unknown project" group always last.
 *
 * When `scopeAll` is false we filter to only the current project's group.
 */
export const buildGroups = (
  data: PickerData,
  currentProjectId: ProjectId | undefined,
  scopeAll: boolean
): readonly SprintGroup[] => {
  const buckets = new Map<string, { label: string; orphan: boolean; sprints: Sprint[] }>();

  // Pre-seed a bucket for every known project so empty projects still render a header when
  // scopeAll is true. Orphan bucket is created lazily on the first orphan sprint.
  for (const project of data.projectsById.values()) {
    buckets.set(project.id, { label: project.displayName, orphan: false, sprints: [] });
  }
  for (const sprint of data.sprints) {
    const bucket = buckets.get(sprint.projectId);
    if (bucket !== undefined) {
      bucket.sprints.push(sprint);
      continue;
    }
    // Orphan: project deleted but sprint persists. Bucket lazily.
    const orphanBucket = buckets.get(UNKNOWN_PROJECT_KEY) ?? {
      label: UNKNOWN_PROJECT_LABEL,
      orphan: true,
      sprints: [] as Sprint[],
    };
    orphanBucket.sprints.push(sprint);
    buckets.set(UNKNOWN_PROJECT_KEY, orphanBucket);
  }

  // Newest first within each bucket.
  for (const bucket of buckets.values()) {
    bucket.sprints.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  }

  const all: SprintGroup[] = Array.from(buckets.entries()).map(([key, b]) => ({
    key,
    label: b.label,
    orphan: b.orphan,
    sprints: b.sprints,
  }));

  // Sort: current project first; orphan last; alphabetical between.
  all.sort((a, b) => {
    if (a.orphan && !b.orphan) return 1;
    if (!a.orphan && b.orphan) return -1;
    if (currentProjectId !== undefined) {
      if (a.key === currentProjectId && b.key !== currentProjectId) return -1;
      if (b.key === currentProjectId && a.key !== currentProjectId) return 1;
    }
    return a.label.localeCompare(b.label);
  });

  if (scopeAll) return all;
  // scoped: keep only the current project's group (if it exists; otherwise return empty).
  return all.filter((g) => g.key === currentProjectId);
};

/**
 * Flatten groups into the cursor-navigable row list. Empty groups still emit a header. The
 * `+ Create new sprint` action row is prepended (when `includeCreate` is true) so it sits at
 * the top of the cursor's reachable rows; Enter on it launches create-sprint via the shared
 * launcher (which reseats selection on success).
 */
export const flatten = (groups: readonly SprintGroup[], includeCreate: boolean): readonly FlatRow[] => {
  const rows: FlatRow[] = [];
  if (includeCreate) rows.push({ kind: 'create' });
  for (const g of groups) {
    rows.push({
      kind: 'header',
      groupKey: g.key,
      label: g.label,
      orphan: g.orphan,
      empty: g.sprints.length === 0,
    });
    for (const sprint of g.sprints) {
      rows.push({ kind: 'sprint', groupKey: g.key, sprint });
    }
  }
  return rows;
};

/** Sentinel id for the synthetic `+ Create new sprint` row — never collides with a real sprint id. */
const CREATE_ROW_ID = '__create__';

/** Rows the cursor is allowed to land on (sprint + create rows; never headers). */
export const cursorableRows = (rows: readonly FlatRow[]): ReadonlyArray<SprintRow | CreateActionRow> =>
  rows.filter((r): r is SprintRow | CreateActionRow => r.kind !== 'header');

/** Stable id for a cursorable row — the `getId` fed to `useListWindow`. */
export const cursorableRowId = (row: SprintRow | CreateActionRow): string =>
  row.kind === 'create' ? CREATE_ROW_ID : row.sprint.id;

/**
 * Preferred landing id within `rows`: the row for `preferredSprintId` if present, else the first
 * sprint row, else the first cursorable row (the synthetic create row), else `''`. Used to seed
 * `useListWindow`'s `initialCursorId` — both on first mount (once the async load settles) and on
 * an explicit scope-toggle remount — so "Enter is a one-keystroke confirm" pre-seeds onto the
 * already-selected sprint whenever possible.
 */
export const preferredCursorId = (rows: readonly FlatRow[], preferredSprintId: SprintId | undefined): string => {
  if (preferredSprintId !== undefined) {
    const match = rows.find((r): r is SprintRow => r.kind === 'sprint' && r.sprint.id === preferredSprintId);
    if (match !== undefined) return match.sprint.id;
  }
  const firstSprint = rows.find((r): r is SprintRow => r.kind === 'sprint');
  if (firstSprint !== undefined) return firstSprint.sprint.id;
  const firstCreate = rows.find((r): r is CreateActionRow => r.kind === 'create');
  return firstCreate !== undefined ? CREATE_ROW_ID : '';
};
