/**
 * Pure list-shaping helpers for the context switcher: bucket sprints into project groups, flatten
 * the groups into the cursor-navigable row list, and derive the id-keyed cursorable subset that
 * feeds the shared `useListWindow` primitive. Project headers are cursor targets (`↵` switches the
 * project); only the orphan bucket's header is not.
 */

import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import {
  type CreateActionRow,
  type CursorRow,
  type FlatRow,
  type HeaderRow,
  type PickerData,
  type SprintGroup,
  type SprintRow,
  UNKNOWN_PROJECT_KEY,
  UNKNOWN_PROJECT_LABEL,
} from '@src/application/ui/tui/components/context-switcher-internals/types.ts';

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
  const buckets = new Map<
    string,
    { label: string; orphan: boolean; projectId: ProjectId | undefined; repoCount: number; sprints: Sprint[] }
  >();

  // Pre-seed a bucket for every known project so empty projects still render a header when
  // scopeAll is true. Orphan bucket is created lazily on the first orphan sprint.
  for (const project of data.projectsById.values()) {
    buckets.set(project.id, {
      label: project.displayName,
      orphan: false,
      projectId: project.id,
      repoCount: project.repositories.length,
      sprints: [],
    });
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
      projectId: undefined,
      repoCount: 0,
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
    projectId: b.projectId,
    repoCount: b.repoCount,
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
      projectId: g.projectId,
      repoCount: g.repoCount,
    });
    for (const sprint of g.sprints) {
      rows.push({ kind: 'sprint', groupKey: g.key, sprint });
    }
  }
  return rows;
};

/** Sentinel id for the synthetic `+ New sprint` row — never collides with a real sprint id. */
const CREATE_ROW_ID = '__create__';

const HEADER_ID_PREFIX = 'project:';

/** Rows the cursor is allowed to land on: sprint, create, and non-orphan project headers. */
export const cursorableRows = (rows: readonly FlatRow[]): readonly CursorRow[] =>
  rows.filter((r) => r.kind !== 'header' || !r.orphan);

/** Stable id for a cursorable row — the `getId` fed to `useListWindow`. */
export const cursorableRowId = (row: CursorRow): string => {
  if (row.kind === 'create') return CREATE_ROW_ID;
  if (row.kind === 'header') return `${HEADER_ID_PREFIX}${row.groupKey}`;
  return row.sprint.id;
};

/**
 * Preferred landing id within `rows`. `focus: 'project'` (`P`) lands on the current project's
 * header; `'sprint'` (`S`) lands on the current sprint. Either falls back to the first sprint row,
 * then the first header, then the create row — so `↵` always has something sensible to confirm.
 */
export const preferredCursorId = (
  rows: readonly FlatRow[],
  preferred: {
    readonly focus: 'sprint' | 'project';
    readonly sprintId: SprintId | undefined;
    readonly projectId: ProjectId | undefined;
  }
): string => {
  const headerOf = (projectId: ProjectId | undefined): HeaderRow | undefined =>
    projectId === undefined
      ? undefined
      : rows.find((r): r is HeaderRow => r.kind === 'header' && !r.orphan && r.groupKey === projectId);
  const sprintRow =
    preferred.sprintId !== undefined
      ? rows.find((r): r is SprintRow => r.kind === 'sprint' && r.sprint.id === preferred.sprintId)
      : undefined;

  if (preferred.focus === 'project') {
    const header = headerOf(preferred.projectId);
    if (header !== undefined) return cursorableRowId(header);
  }
  if (sprintRow !== undefined) return cursorableRowId(sprintRow);
  const firstSprint = rows.find((r): r is SprintRow => r.kind === 'sprint');
  if (firstSprint !== undefined) return cursorableRowId(firstSprint);
  const firstHeader = rows.find((r): r is HeaderRow => r.kind === 'header' && !r.orphan);
  if (firstHeader !== undefined) return cursorableRowId(firstHeader);
  const firstCreate = rows.find((r): r is CreateActionRow => r.kind === 'create');
  return firstCreate !== undefined ? CREATE_ROW_ID : '';
};
