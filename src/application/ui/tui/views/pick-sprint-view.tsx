/**
 * Sprint picker — cross-project by default. Lists every sprint grouped by project so the user
 * can switch project + sprint in one keystroke. Loads both repositories in parallel; orders
 * groups with the current project first, then alphabetical by project label; newest sprint
 * first within each group (UUIDv7 sort, reversed). `t` toggles between "all projects" (the
 * default) and "current project only"; `f` hides done sprints (default off — closed sprints
 * stay reachable here by contract).
 *
 * Picking a sprint that belongs to a different project than the current selection calls
 * `selection.setProjectAndSprint` so both ids switch in a single state batch — chaining
 * `setProject` + `setSprint` would briefly null the sprint cursor (setProject side effect)
 * and fire the persistence write twice.
 *
 * Cursor + windowing are owned by the shared `useListWindow` primitive (id-keyed on the
 * cursorable row subset — see `pick-sprint-internals/row-views.tsx`'s `PickerRowList`), not a
 * bespoke index. The `t` scope toggle forces an explicit reseat to the preferred sprint by
 * remounting `PickerRowList` (`key` includes `scopeAll`); the `f` done-filter does NOT remount,
 * so a manually-navigated row that survives the filter keeps focus — `useListWindow`'s own
 * id-resolution (snap to nearest survivor by prior index on eviction) handles the rest.
 *
 * List shaping (group/flatten/cursorable-subset) lives under `pick-sprint-internals/`; this file
 * is the orchestrator that wires data → hooks → row presentation.
 */

import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { ViewShell } from '@src/application/ui/tui/components/view-shell.tsx';
import { LoadErrorRow, LoadingRow } from '@src/application/ui/tui/components/async-rows.tsx';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { useDeps } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { useRouter } from '@src/application/ui/tui/runtime/router.tsx';
import { useSelection } from '@src/application/ui/tui/runtime/selection-context.tsx';
import { useAsyncLoad, type AsyncLoadState } from '@src/application/ui/tui/runtime/use-async-load.ts';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { useViewHints } from '@src/application/ui/tui/runtime/use-view-hints.tsx';
import { useBreakpoint } from '@src/application/ui/tui/runtime/use-breakpoint.ts';
import { useLaunchCreateSprint } from '@src/application/ui/tui/runtime/use-launch-create-sprint.ts';
import { HelpOverlay } from '@src/application/ui/tui/components/help-overlay.tsx';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type {
  CreateActionRow,
  FlatRow,
  PickerData,
  SprintRow,
} from '@src/application/ui/tui/views/pick-sprint-internals/types.ts';
import {
  buildGroups,
  flatten,
  preferredCursorId,
} from '@src/application/ui/tui/views/pick-sprint-internals/group-builder.ts';
import {
  computeWindow,
  MIN_VISIBLE_ROWS,
  VERTICAL_CHROME_ROWS,
} from '@src/application/ui/tui/views/pick-sprint-internals/window.ts';
import { PickerRowList } from '@src/application/ui/tui/views/pick-sprint-internals/row-views.tsx';

type Selection = ReturnType<typeof useSelection>;

interface UsePickerRowsResult {
  readonly state: AsyncLoadState<PickerData, unknown>;
  readonly reload: () => void;
  readonly data: PickerData;
  readonly rows: readonly FlatRow[];
  readonly sprintCount: number;
  readonly hiddenByDoneFilter: boolean;
  readonly scopeAll: boolean;
  readonly hideDone: boolean;
  readonly setHideDone: React.Dispatch<React.SetStateAction<boolean>>;
  readonly toggleScope: () => void;
}

/**
 * Load the raw sprint/project snapshot, derive the filtered + grouped + flattened row list, and
 * own the cursor's position within it (including reseating on scope/filter toggles and on data
 * reload). Kept as one hook so the picker's data pipeline and cursor bookkeeping — which must
 * always agree on the same `rows` — can't drift apart across separate `useMemo` call sites.
 */
const usePickerRows = (deps: AppDeps, selection: Selection): UsePickerRowsResult => {
  const [scopeAll, setScopeAll] = useState<boolean>(true);
  // Default OFF — closed sprints stay reachable here by contract (the Home shortcut list
  // already filters them; this picker is the documented way back to a done sprint).
  const [hideDone, setHideDone] = useState<boolean>(false);

  const { state, reload } = useAsyncLoad<PickerData>(
    async (signal) => {
      const [sprintsR, projectsR] = await Promise.all([deps.sprintRepo.list(), deps.projectRepo.list()]);
      // Short-circuit on unmount / re-fetch: the underlying repo calls don't yet accept a signal,
      // so we can't truly cancel the I/O — but bailing here avoids parsing a stale result and
      // lets `useAsyncLoad` swallow the AbortError as a silent cancel.
      signal.throwIfAborted();
      if (!sprintsR.ok) throw new Error(sprintsR.error.message);
      if (!projectsR.ok) throw new Error(projectsR.error.message);
      const projectsById = new Map<ProjectId, Project>();
      for (const p of projectsR.value) projectsById.set(p.id, p);
      return { sprints: sprintsR.value, projectsById };
    },
    [deps.sprintRepo, deps.projectRepo]
  );

  // Stabilise the loading-state placeholder so `useMemo(buildGroups, [data, …])` keeps its
  // identity across renders while the fetch is pending.
  const data: PickerData = useMemo(
    () => (state.kind === 'ok' ? state.value : { sprints: [], projectsById: new Map() }),
    [state]
  );

  // Shared filtered view — BOTH the group build below and the `t`-toggle cursor reseat must
  // derive from the same list, or toggling scope would reseat the cursor against unfiltered
  // rows while the screen renders filtered ones.
  const visibleData: PickerData = useMemo(
    () => (hideDone ? { ...data, sprints: data.sprints.filter((s) => s.status !== 'done') } : data),
    [data, hideDone]
  );

  const groups = useMemo(
    () => buildGroups(visibleData, selection.projectId, scopeAll),
    [visibleData, selection.projectId, scopeAll]
  );
  // Only inject the `+ Create new sprint` action row when a project is selected — without one
  // there's nothing to create the sprint against, so the synthetic row would just surface a
  // "select a project first" error on Enter. Skipping it keeps the picker honest.
  const includeCreate = selection.projectId !== undefined;
  const rows = useMemo(() => flatten(groups, includeCreate), [groups, includeCreate]);
  const sprintCount = useMemo(() => rows.reduce((acc, r) => (r.kind === 'sprint' ? acc + 1 : acc), 0), [rows]);

  // Distinguish "the f filter hid everything in scope" from a genuinely empty scope so the
  // empty state names the right escape hatch (press f vs press +). Checked against the
  // UNfiltered data under the same project scope — `data.sprints` alone would miscount when
  // another project's sprints exist outside the current scope.
  const hiddenByDoneFilter = useMemo(() => {
    if (!hideDone || sprintCount > 0) return false;
    return flatten(buildGroups(data, selection.projectId, scopeAll), false).some((r) => r.kind === 'sprint');
  }, [hideDone, sprintCount, data, selection.projectId, scopeAll]);

  const toggleScope = (): void => setScopeAll((v) => !v);

  return {
    state,
    reload,
    data,
    rows,
    sprintCount,
    hiddenByDoneFilter,
    scopeAll,
    hideDone,
    setHideDone,
    toggleScope,
  };
};

interface PickerBodyProps {
  readonly helpOpen: boolean;
  readonly state: AsyncLoadState<PickerData, unknown>;
  readonly sprintCount: number;
  readonly hiddenByDoneFilter: boolean;
  readonly scopeAll: boolean;
  readonly hideDone: boolean;
  readonly rows: readonly FlatRow[];
  readonly visibleRows: number;
  readonly listActive: boolean;
  readonly initialCursorId: string;
  readonly listKey: string;
  readonly currentSprintId: SprintId | undefined;
  readonly currentSprintLabel: string | undefined;
  readonly feedback: string | undefined;
  readonly onRowSubmit: (row: SprintRow | CreateActionRow) => void;
}

/** Loading / error / empty / list-of-rows presentation — pure props in, no state of its own. */
const PickerBody = ({
  helpOpen,
  state,
  sprintCount,
  hiddenByDoneFilter,
  scopeAll,
  hideDone,
  rows,
  visibleRows,
  listActive,
  initialCursorId,
  listKey,
  currentSprintId,
  currentSprintLabel,
  feedback,
  onRowSubmit,
}: PickerBodyProps): React.JSX.Element =>
  helpOpen ? (
    <HelpOverlay />
  ) : state.kind === 'loading' || state.kind === 'idle' ? (
    <LoadingRow label="Loading sprints…" />
  ) : state.kind === 'error' ? (
    <LoadErrorRow message="Failed to load sprints." color={inkColors.error} />
  ) : sprintCount === 0 ? (
    <Box flexDirection="column" paddingX={spacing.indent}>
      {hiddenByDoneFilter ? (
        <>
          <Text>All sprints here are done (hidden).</Text>
          <Text dimColor>Press f to show them, or + to create a new one.</Text>
        </>
      ) : (
        <>
          <Text>No sprints yet.</Text>
          <Text dimColor>
            {scopeAll ? 'Press + to create one.' : 'Press t to show all projects, or + to create one.'}
          </Text>
        </>
      )}
    </Box>
  ) : (
    <Box flexDirection="column">
      <Box paddingX={spacing.indent} marginBottom={spacing.section}>
        <Text dimColor>
          {String(sprintCount)} sprint{sprintCount === 1 ? '' : 's'} {glyphs.bullet}{' '}
          {scopeAll ? 'all projects' : 'current project only'} {glyphs.bullet}{' '}
          {currentSprintLabel !== undefined ? (
            <Text>
              current:{' '}
              <Text color={inkColors.primary} bold>
                {currentSprintLabel}
              </Text>
            </Text>
          ) : (
            <Text>press ↵ to confirm</Text>
          )}
        </Text>
      </Box>
      <PickerRowList
        key={listKey}
        rows={rows}
        visibleRows={visibleRows}
        active={listActive}
        initialCursorId={initialCursorId}
        currentSprintId={currentSprintId}
        onSubmit={onRowSubmit}
      />
      <Box marginTop={spacing.section} paddingX={spacing.indent}>
        <Text dimColor>
          {glyphs.bullet} ↵ use the highlighted sprint {glyphs.bullet} t toggle scope {glyphs.bullet} f{' '}
          {hideDone ? 'show' : 'hide'} done {glyphs.bullet} + create a new one
        </Text>
      </Box>
      {feedback !== undefined && (
        <Box paddingX={spacing.indent} marginTop={spacing.section}>
          <Text color={inkColors.error}>{feedback}</Text>
        </Box>
      )}
    </Box>
  );

/**
 * Re-export of the windowing helper. Kept at this canonical path so the existing unit-test
 * import (`@src/application/ui/tui/views/pick-sprint-view.tsx`) continues to resolve without
 * churn after the split.
 *
 * @public
 */
export { computeWindow };

export const PickSprintView = (): React.JSX.Element => {
  const deps = useDeps();
  const router = useRouter();
  const selection = useSelection();
  const ui = useUiState();
  const [feedback, setFeedback] = useState<string | undefined>(undefined);

  const { state, reload, data, rows, sprintCount, hiddenByDoneFilter, scopeAll, hideDone, setHideDone, toggleScope } =
    usePickerRows(deps, selection);

  useViewHints([
    { keys: '↑/↓/j/k', label: 'move' },
    { keys: '↵', label: 'use sprint' },
    { keys: 't', label: 'toggle scope' },
    { keys: 'f', label: hideDone ? 'show done' : 'hide done' },
    { keys: 'c/+', label: 'create new' },
    { keys: 'r', label: 'reload' },
  ]);

  // Window the rendered slice so a user with hundreds of sprints across many projects doesn't
  // pay an Ink reconciliation cost proportional to the full row list. Capacity tracks terminal
  // height so the visible slice always fills the viewport without overflowing it.
  const bp = useBreakpoint();
  const visibleRows = Math.max(MIN_VISIBLE_ROWS, bp.rows - VERTICAL_CHROME_ROWS);

  const pick = (sprint: Sprint): void => {
    if (sprint.projectId !== selection.projectId) {
      const project = data.projectsById.get(sprint.projectId);
      if (project !== undefined) {
        selection.setProjectAndSprint(project.id, project.displayName, sprint.id, sprint.name, sprint.status);
        router.reset({ id: 'home' });
        return;
      }
      // Orphan: project deleted. Fall through to plain setSprint — the sprint will surface
      // under whatever project the selection still points at (or none).
    }
    selection.setSprint(sprint.id, sprint.name, sprint.status);
    router.reset({ id: 'home' });
  };

  // Route create-sprint through the shared sprint-bound launcher so the post-completion
  // selection reseat lives in one place (see launch/sprint-bound.ts). Failures surface inline;
  // success pushes the execute view.
  const launchCreateSprint = useLaunchCreateSprint({
    onError: setFeedback,
    noProjectMessage: `${glyphs.cross} select a project first`,
  });

  const onRowSubmit = (row: SprintRow | CreateActionRow): void => {
    if (row.kind === 'sprint') pick(row.sprint);
    else void launchCreateSprint();
  };

  // Non-navigation keys only — `PickerRowList`'s `useListWindow` owns ↑/↓/j/k/PgUp/PgDn/Home/End/Enter.
  useInput((input) => {
    if (ui.modalOpen) return;
    if (input === 't') {
      toggleScope();
      return;
    }
    if (input === 'f') {
      setHideDone((v) => !v);
      return;
    }
    if (input === '+' || input === 'c') {
      void launchCreateSprint();
      return;
    }
    if (input === 'r') reload();
  });

  // The preferred landing id — the already-selected sprint if present, else the first sprint,
  // else the create row. Recomputed every render but only actually consumed by `useListWindow`
  // at (re)mount time (see `listKey` below); it never forces a reseat on an already-mounted list.
  const initialCursorId = useMemo(() => preferredCursorId(rows, selection.sprintId), [rows, selection.sprintId]);

  // Remount the row list — and so its `useListWindow` cursor — on an explicit scope toggle (`t`)
  // or when the persisted selection changes (covers the selection context arriving a tick after
  // first render). This is the ONLY case that force-reseats onto `initialCursorId`; the `f`
  // done-filter does NOT change this key, so a manually-navigated row that survives the filter
  // keeps focus via `useListWindow`'s own id resolution (see the module doc comment above).
  const listKey = `${String(scopeAll)}-${selection.sprintId ?? 'unseeded'}`;

  return (
    <ViewShell title="Pick a sprint" subtitle="Switch sprint (and project) in one step" suppressScrollArrows>
      <PickerBody
        helpOpen={ui.helpOpen}
        state={state}
        sprintCount={sprintCount}
        hiddenByDoneFilter={hiddenByDoneFilter}
        scopeAll={scopeAll}
        hideDone={hideDone}
        rows={rows}
        visibleRows={visibleRows}
        listActive={!ui.modalOpen}
        initialCursorId={initialCursorId}
        listKey={listKey}
        currentSprintId={selection.sprintId}
        currentSprintLabel={selection.sprintLabel}
        feedback={feedback}
        onRowSubmit={onRowSubmit}
      />
    </ViewShell>
  );
};
