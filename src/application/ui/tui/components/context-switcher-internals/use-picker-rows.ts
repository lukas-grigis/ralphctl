/**
 * Data pipeline for the context switcher: load the raw sprint / project / task-health snapshot, derive the filtered +
 * grouped + flattened row list, and own the scope (`t`) and done-filter (`f`) toggles.
 */

import { useMemo, useState } from 'react';
import { useAsyncLoad, type AsyncLoadState } from '@src/application/ui/tui/runtime/use-async-load.ts';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import { loadTaskHealthBySprintId } from '@src/application/ui/shared/state-snapshot.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { FlatRow, PickerData } from '@src/application/ui/tui/components/context-switcher-internals/types.ts';
import { buildGroups, flatten } from '@src/application/ui/tui/components/context-switcher-internals/group-builder.ts';

export interface UsePickerRowsResult {
  readonly state: AsyncLoadState<PickerData, unknown>;
  readonly reload: () => void;
  readonly data: PickerData;
  readonly rows: readonly FlatRow[];
  readonly sprintCount: number;
  readonly projectCount: number;
  readonly hiddenByDoneFilter: boolean;
  readonly scopeAll: boolean;
  readonly hideDone: boolean;
  readonly toggleHideDone: () => void;
  readonly toggleScope: () => void;
}

export const usePickerRows = (deps: AppDeps, currentProjectId: ProjectId | undefined): UsePickerRowsResult => {
  const [scopeAll, setScopeAll] = useState<boolean>(true);
  // Default OFF — closed sprints stay reachable here by contract (Work only lists open ones; this
  // is the documented way back to a done sprint).
  const [hideDone, setHideDone] = useState<boolean>(false);

  const { state, reload } = useAsyncLoad<PickerData>(
    async (signal) => {
      const [sprintsR, projectsR] = await Promise.all([deps.sprintRepo.list(), deps.projectRepo.list()]);
      // Short-circuit on unmount / re-fetch: the repo calls can't be cancelled yet, but bailing skips parsing a stale
      // result.
      signal.throwIfAborted();
      if (!sprintsR.ok) throw new Error(sprintsR.error.message);
      if (!projectsR.ok) throw new Error(projectsR.error.message);
      const projectsById = new Map<ProjectId, Project>();
      for (const p of projectsR.value) projectsById.set(p.id, p);
      // Task-blocked health folded into THIS loader via the shared batch helper — one
      // `Promise.all` alongside the sprint fetch, not a fetch per rendered row.
      const taskHealthBySprintId = await loadTaskHealthBySprintId(deps.taskRepo, sprintsR.value);
      signal.throwIfAborted();
      return { sprints: sprintsR.value, projectsById, taskHealthBySprintId };
    },
    [deps.sprintRepo, deps.projectRepo, deps.taskRepo]
  );

  // Stabilise the loading-state placeholder so the memos keyed on `data` keep their identity
  // across renders while the fetch is pending.
  const data: PickerData = useMemo(
    () =>
      state.kind === 'ok' ? state.value : { sprints: [], projectsById: new Map(), taskHealthBySprintId: new Map() },
    [state]
  );

  // Shared filtered view — BOTH the group build below and the `hiddenByDoneFilter` check derive
  // from the same list, or the empty-state copy would disagree with what the screen renders.
  const visibleData: PickerData = useMemo(
    () => (hideDone ? { ...data, sprints: data.sprints.filter((s) => s.status !== 'done') } : data),
    [data, hideDone]
  );

  const groups = useMemo(
    () => buildGroups(visibleData, currentProjectId, scopeAll),
    [visibleData, currentProjectId, scopeAll]
  );
  // The `+ New sprint` row needs a project to create against — without one the row would only
  // surface a "select a project first" error on Enter, so it is not offered.
  const includeCreate = currentProjectId !== undefined;
  const rows = useMemo(() => flatten(groups, includeCreate), [groups, includeCreate]);
  const sprintCount = useMemo(() => rows.reduce((acc, r) => (r.kind === 'sprint' ? acc + 1 : acc), 0), [rows]);
  const projectCount = useMemo(
    () => rows.reduce((acc, r) => (r.kind === 'header' && !r.orphan ? acc + 1 : acc), 0),
    [rows]
  );

  // Distinguish "the f filter hid everything in scope" from a genuinely empty scope so the empty
  // state names the right escape hatch.
  const hiddenByDoneFilter = useMemo(() => {
    if (!hideDone || sprintCount > 0) return false;
    return flatten(buildGroups(data, currentProjectId, scopeAll), false).some((r) => r.kind === 'sprint');
  }, [hideDone, sprintCount, data, currentProjectId, scopeAll]);

  return {
    state,
    reload,
    data,
    rows,
    sprintCount,
    projectCount,
    hiddenByDoneFilter,
    scopeAll,
    hideDone,
    toggleHideDone: () => setHideDone((v) => !v),
    toggleScope: () => setScopeAll((v) => !v),
  };
};
