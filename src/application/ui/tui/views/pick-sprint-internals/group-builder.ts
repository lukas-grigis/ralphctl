/**
 * Pure list-shaping helpers for the sprint picker: bucket sprints into project groups,
 * flatten the groups into the cursor-navigable row list, and walk that list to the next
 * cursorable index. Headers and overflow indicators are never cursor targets.
 */

import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import {
  type FlatRow,
  type PickerData,
  type SprintGroup,
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

/** Indices of the rows the cursor is allowed to land on (sprint + create rows; never headers). */
export const cursorableRowIndices = (rows: readonly FlatRow[]): readonly number[] => {
  const indices: number[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const kind = rows[i]?.kind;
    if (kind === 'sprint' || kind === 'create') indices.push(i);
  }
  return indices;
};

export const nextCursorableIndex = (rows: readonly FlatRow[], from: number, direction: 1 | -1): number => {
  const candidates = cursorableRowIndices(rows);
  if (candidates.length === 0) return from;
  if (direction === 1) {
    const next = candidates.find((i) => i > from);
    return next ?? from;
  }
  // direction === -1
  let prev = from;
  for (const i of candidates) {
    if (i < from) prev = i;
    else break;
  }
  return prev === from && candidates.includes(from) ? from : prev;
};
