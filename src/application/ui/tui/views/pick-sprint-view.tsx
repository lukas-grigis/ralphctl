/**
 * Sprint picker — cross-project by default. Lists every sprint grouped by project so the user
 * can switch project + sprint in one keystroke. Loads both repositories in parallel; orders
 * groups with the current project first, then alphabetical by project label; newest sprint
 * first within each group (UUIDv7 sort, reversed). `t` toggles between "all projects" (the
 * default) and "current project only".
 *
 * Picking a sprint that belongs to a different project than the current selection calls
 * `selection.setProjectAndSprint` so both ids switch in a single state batch — chaining
 * `setProject` + `setSprint` would briefly null the sprint cursor (setProject side effect)
 * and fire the persistence write twice.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { ViewShell } from '@src/application/ui/tui/components/view-shell.tsx';
import { Spinner } from '@src/application/ui/tui/components/spinner.tsx';
import { StatusChip, sprintStatusKind } from '@src/application/ui/tui/components/status-chip.tsx';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { useDeps } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { useRouter } from '@src/application/ui/tui/runtime/router.tsx';
import { useSelection } from '@src/application/ui/tui/runtime/selection-context.tsx';
import { useAsyncLoad } from '@src/application/ui/tui/runtime/use-async-load.ts';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { useViewHints } from '@src/application/ui/tui/runtime/use-view-hints.tsx';
import { useSessionManager } from '@src/application/ui/tui/runtime/sessions-context.tsx';
import { usePromptQueue } from '@src/application/ui/tui/prompts/prompt-context.tsx';
import { createInkInteractivePrompt } from '@src/application/ui/tui/prompts/ink-interactive-prompt.ts';
import { useStorage } from '@src/application/ui/tui/runtime/storage-context.tsx';
import { getRunInTerminal } from '@src/application/ui/tui/runtime/run-in-terminal.ts';
import { useBreakpoint } from '@src/application/ui/tui/runtime/use-breakpoint.ts';
import { sessionHintsFromLaunchResult } from '@src/application/ui/shared/launcher.ts';
import { launchSprintBoundFlow } from '@src/application/ui/shared/launch/sprint-bound.ts';
import { loadAppStateSnapshot } from '@src/application/ui/shared/state-snapshot.ts';
import { HelpOverlay } from '@src/application/ui/tui/components/help-overlay.tsx';
import type { Project } from '@src/domain/entity/project.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';

const UNKNOWN_PROJECT_KEY = '__unknown__';
const UNKNOWN_PROJECT_LABEL = 'Unknown project';

/**
 * Vertical chrome the picker reserves above + below the row list: title bar (≈3), subtitle (1),
 * summary header + spacing (≈3), footer hint (≈2), scroll indicators (≈2), bottom margin (≈1).
 * The window slice consumes `terminalRows - VERTICAL_CHROME_ROWS`, bounded by
 * {@link MIN_VISIBLE_ROWS} so very short terminals still render a usable list.
 */
const VERTICAL_CHROME_ROWS = 12;
const MIN_VISIBLE_ROWS = 8;

/** @public */
export interface RowWindow {
  readonly start: number;
  readonly end: number;
  readonly hiddenAbove: number;
  readonly hiddenBelow: number;
}

/**
 * Compute a cursor-centred slice of the flat row list. Keeps the focused row near the middle of
 * the window so the user always sees one screen of context above and below. Clamps to row-list
 * bounds; if total rows fit within `visible`, returns the full list with no overflow indicators.
 *
 * Defined as a pure function (test-friendly) — the view memoises the call against `rows`,
 * `cursor`, `visible`.
 *
 * @public
 */
export const computeWindow = (totalRows: number, cursor: number, visible: number): RowWindow => {
  if (totalRows <= visible) return { start: 0, end: totalRows, hiddenAbove: 0, hiddenBelow: 0 };
  const half = Math.floor(visible / 2);
  let start = Math.max(0, cursor - half);
  let end = start + visible;
  if (end > totalRows) {
    end = totalRows;
    start = Math.max(0, end - visible);
  }
  return { start, end, hiddenAbove: start, hiddenBelow: totalRows - end };
};

interface PickerData {
  readonly sprints: readonly Sprint[];
  readonly projectsById: ReadonlyMap<ProjectId, Project>;
}

interface HeaderRow {
  readonly kind: 'header';
  readonly groupKey: string;
  readonly label: string;
  readonly orphan: boolean;
  readonly empty: boolean;
}

interface SprintRow {
  readonly kind: 'sprint';
  readonly groupKey: string;
  readonly sprint: Sprint;
}

/**
 * Synthetic top row that routes through the create-sprint flow. Sits above the project groups
 * so the user can launch creation without scrolling past every existing sprint, and so an
 * "empty-storage" picker (no sprints anywhere yet) still surfaces a productive action.
 */
interface CreateActionRow {
  readonly kind: 'create';
}

type FlatRow = HeaderRow | SprintRow | CreateActionRow;

interface SprintGroup {
  readonly key: string;
  readonly label: string;
  readonly orphan: boolean;
  readonly sprints: readonly Sprint[];
}

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
const buildGroups = (
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
const flatten = (groups: readonly SprintGroup[], includeCreate: boolean): readonly FlatRow[] => {
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
const cursorableRowIndices = (rows: readonly FlatRow[]): readonly number[] => {
  const indices: number[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const kind = rows[i]?.kind;
    if (kind === 'sprint' || kind === 'create') indices.push(i);
  }
  return indices;
};

const nextCursorableIndex = (rows: readonly FlatRow[], from: number, direction: 1 | -1): number => {
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

export const PickSprintView = (): React.JSX.Element => {
  const deps = useDeps();
  const router = useRouter();
  const selection = useSelection();
  const ui = useUiState();
  const sessions = useSessionManager();
  const queue = usePromptQueue();
  const storage = useStorage();
  const [feedback, setFeedback] = useState<string | undefined>(undefined);
  const [scopeAll, setScopeAll] = useState<boolean>(true);
  useViewHints([
    { keys: '↵', label: 'use sprint' },
    { keys: 't', label: 'toggle scope' },
    { keys: '+', label: 'create new' },
    { keys: 'r', label: 'reload' },
  ]);

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

  const groups = useMemo(() => buildGroups(data, selection.projectId, scopeAll), [data, selection.projectId, scopeAll]);
  // Only inject the `+ Create new sprint` action row when a project is selected — without one
  // there's nothing to create the sprint against, so the synthetic row would just surface a
  // "select a project first" error on Enter. Skipping it keeps the picker honest.
  const includeCreate = selection.projectId !== undefined;
  const rows = useMemo(() => flatten(groups, includeCreate), [groups, includeCreate]);
  const sprintCount = useMemo(() => rows.reduce((acc, r) => (r.kind === 'sprint' ? acc + 1 : acc), 0), [rows]);

  // Window the rendered slice so a user with hundreds of sprints across many projects doesn't
  // pay an Ink reconciliation cost proportional to the full row list. Capacity tracks terminal
  // height so the visible slice always fills the viewport without overflowing it.
  const bp = useBreakpoint();
  const visibleRows = Math.max(MIN_VISIBLE_ROWS, bp.rows - VERTICAL_CHROME_ROWS);

  // Pre-seed the cursor to the already-selected sprint so Enter is a one-keystroke confirm.
  // Otherwise, prefer the first sprint row over the synthetic `+ create` row so users with
  // existing sprints can still press Enter to pick the topmost one — the create row sits at
  // the very top but is intentionally NOT the initial focus (the common case is "switch", not
  // "create"). When the picker is completely empty (no sprints anywhere), the create row IS
  // first cursorable, so the fallback still lands on it.
  const initialIdx = useMemo(() => {
    if (selection.sprintId !== undefined) {
      const i = rows.findIndex((r) => r.kind === 'sprint' && r.sprint.id === selection.sprintId);
      if (i !== -1) return i;
    }
    const firstSprint = rows.findIndex((r) => r.kind === 'sprint');
    if (firstSprint !== -1) return firstSprint;
    return cursorableRowIndices(rows)[0] ?? 0;
  }, [rows, selection.sprintId]);

  const [cursor, setCursor] = useState<number>(initialIdx);
  useEffect(() => {
    setCursor((c) => {
      if (rows.length === 0) return 0;
      if (c >= rows.length) return Math.max(0, rows.length - 1);
      // Snap cursor back onto a cursorable row if a re-group landed it on a header.
      const focused = rows[c];
      if (focused?.kind !== 'sprint' && focused?.kind !== 'create') {
        return cursorableRowIndices(rows)[0] ?? c;
      }
      return c;
    });
  }, [rows]);
  useEffect(() => {
    setCursor(initialIdx);
  }, [initialIdx]);

  const pick = (sprint: Sprint): void => {
    if (sprint.projectId !== selection.projectId) {
      const project = data.projectsById.get(sprint.projectId);
      if (project !== undefined) {
        selection.setProjectAndSprint(project.id, project.displayName, sprint.id, sprint.name);
        router.reset({ id: 'home' });
        return;
      }
      // Orphan: project deleted. Fall through to plain setSprint — the sprint will surface
      // under whatever project the selection still points at (or none).
    }
    selection.setSprint(sprint.id, sprint.name);
    router.reset({ id: 'home' });
  };

  // Route create-sprint through the shared sprint-bound launcher so the post-completion
  // selection reseat lives in one place (see launch/sprint-bound.ts). Failures surface inline;
  // success pushes the execute view.
  const launchCreateSprint = async (): Promise<void> => {
    if (selection.projectId === undefined) {
      setFeedback('✗ select a project first');
      return;
    }
    const snapshot = await loadAppStateSnapshot(
      { projectRepo: deps.projectRepo, sprintRepo: deps.sprintRepo, taskRepo: deps.taskRepo },
      { projectId: selection.projectId }
    );
    const interactive = createInkInteractivePrompt(queue);
    const result = await launchSprintBoundFlow(
      { app: deps, interactive, storage, runInTerminal: getRunInTerminal() },
      'create-sprint',
      snapshot,
      {
        onReseat: ({ id, name }) => {
          selection.setSprint(id, name);
        },
      }
    );
    if (!result.ok) {
      setFeedback(`✗ ${result.reason}`);
      return;
    }
    sessions.register({
      runner: result.runner,
      flowId: 'create-sprint',
      title: result.title,
      ...sessionHintsFromLaunchResult(result),
    });
    void result.runner.start();
    router.push({ id: 'execute', props: { sessionId: result.runner.id } });
  };

  const toggleScope = (): void => {
    const next = !scopeAll;
    setScopeAll(next);
    // Recompute the cursor: prefer the already-selected sprint, then the first sprint row,
    // then the create row (only relevant on a totally empty picker).
    const nextRows = flatten(buildGroups(data, selection.projectId, next), includeCreate);
    let idx = -1;
    if (selection.sprintId !== undefined) {
      idx = nextRows.findIndex((r) => r.kind === 'sprint' && r.sprint.id === selection.sprintId);
    }
    if (idx === -1) idx = nextRows.findIndex((r) => r.kind === 'sprint');
    if (idx === -1) idx = cursorableRowIndices(nextRows)[0] ?? 0;
    setCursor(idx);
  };

  useInput((input, key) => {
    if (ui.helpOpen || ui.promptActive) return;
    if (key.upArrow || input === 'k') {
      setCursor((c) => nextCursorableIndex(rows, c, -1));
      return;
    }
    if (key.downArrow || input === 'j') {
      setCursor((c) => nextCursorableIndex(rows, c, 1));
      return;
    }
    if (key.return) {
      const row = rows[cursor];
      if (row?.kind === 'sprint') pick(row.sprint);
      else if (row?.kind === 'create') void launchCreateSprint();
      return;
    }
    if (input === 't') {
      toggleScope();
      return;
    }
    if (input === '+' || input === 'c') {
      void launchCreateSprint();
      return;
    }
    if (input === 'r') reload();
  });

  return (
    <ViewShell title="Pick a sprint" subtitle="Switch sprint (and project) in one step">
      {ui.helpOpen ? (
        <HelpOverlay />
      ) : state.kind === 'loading' || state.kind === 'idle' ? (
        <Box paddingX={spacing.indent}>
          <Spinner label="Loading sprints…" />
        </Box>
      ) : state.kind === 'error' ? (
        <Box paddingX={spacing.indent}>
          <Text color={inkColors.error}>Failed to load sprints.</Text>
        </Box>
      ) : sprintCount === 0 ? (
        <Box flexDirection="column" paddingX={spacing.indent}>
          <Text>No sprints yet.</Text>
          <Text dimColor>
            {scopeAll ? 'Press + to create one.' : 'Press t to show all projects, or + to create one.'}
          </Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          <Box paddingX={spacing.indent} marginBottom={spacing.section}>
            <Text dimColor>
              {String(sprintCount)} sprint{sprintCount === 1 ? '' : 's'} {glyphs.bullet}{' '}
              {scopeAll ? 'all projects' : 'current project only'} {glyphs.bullet}{' '}
              {selection.sprintLabel !== undefined ? (
                <Text>
                  current:{' '}
                  <Text color={inkColors.primary} bold>
                    {selection.sprintLabel}
                  </Text>
                </Text>
              ) : (
                <Text>press ↵ to confirm</Text>
              )}
            </Text>
          </Box>
          <RowWindowView rows={rows} cursor={cursor} visibleRows={visibleRows} currentSprintId={selection.sprintId} />
          <Box marginTop={spacing.section} paddingX={spacing.indent}>
            <Text dimColor>
              {glyphs.bullet} ↵ use the highlighted sprint {glyphs.bullet} t toggle scope {glyphs.bullet} + create a new
              one
            </Text>
          </Box>
          {feedback !== undefined && (
            <Box paddingX={spacing.indent} marginTop={1}>
              <Text color={inkColors.error}>{feedback}</Text>
            </Box>
          )}
        </Box>
      )}
    </ViewShell>
  );
};

interface RowWindowViewProps {
  readonly rows: readonly FlatRow[];
  readonly cursor: number;
  readonly visibleRows: number;
  readonly currentSprintId: string | undefined;
}

const RowWindowView = ({ rows, cursor, visibleRows, currentSprintId }: RowWindowViewProps): React.JSX.Element => {
  const window = useMemo(() => computeWindow(rows.length, cursor, visibleRows), [rows.length, cursor, visibleRows]);
  const slice = rows.slice(window.start, window.end);
  return (
    <Box flexDirection="column">
      {window.hiddenAbove > 0 && (
        <Box paddingX={spacing.indent}>
          <Text dimColor>▲ {String(window.hiddenAbove)} more above</Text>
        </Box>
      )}
      {slice.map((row, i) => {
        const absoluteIndex = i + window.start;
        if (row.kind === 'header') {
          return <HeaderRowView key={`h-${row.groupKey}-${String(absoluteIndex)}`} row={row} />;
        }
        if (row.kind === 'create') {
          return <CreateRowView key={`create-${String(absoluteIndex)}`} focused={absoluteIndex === cursor} />;
        }
        return (
          <SprintRowView
            key={row.sprint.id}
            sprint={row.sprint}
            focused={absoluteIndex === cursor}
            isCurrent={currentSprintId === row.sprint.id}
          />
        );
      })}
      {window.hiddenBelow > 0 && (
        <Box paddingX={spacing.indent}>
          <Text dimColor>▼ {String(window.hiddenBelow)} more below</Text>
        </Box>
      )}
    </Box>
  );
};

const CreateRowView = ({ focused }: { readonly focused: boolean }): React.JSX.Element => (
  <Box flexDirection="column" paddingX={spacing.indent}>
    <Box>
      <Text color={focused ? inkColors.primary : inkColors.rule}>{focused ? '▍' : ' '}</Text>
      <Text>
        {' '}
        <Text color={focused ? inkColors.primary : inkColors.highlight} bold>
          + Create new sprint
        </Text>
      </Text>
    </Box>
    {focused && (
      <Box paddingLeft={3}>
        <Text dimColor>{glyphs.activityArrow} launches the create-sprint flow</Text>
      </Box>
    )}
  </Box>
);

const HeaderRowView = ({ row }: { readonly row: HeaderRow }): React.JSX.Element => {
  const color = row.orphan ? inkColors.warning : inkColors.muted;
  const prefix = row.orphan ? `${glyphs.warningGlyph} ` : '';
  return (
    <Box flexDirection="column" paddingX={spacing.indent} marginTop={spacing.section}>
      <Text bold color={color}>
        {prefix}
        {row.label}
      </Text>
      {row.empty && (
        <Box paddingLeft={3}>
          <Text dimColor>{glyphs.bullet} no sprints</Text>
        </Box>
      )}
    </Box>
  );
};

const SprintRowView = ({
  sprint,
  focused,
  isCurrent,
}: {
  readonly sprint: Sprint;
  readonly focused: boolean;
  readonly isCurrent: boolean;
}): React.JSX.Element => {
  return (
    <Box flexDirection="column" paddingX={spacing.indent}>
      <Box>
        <Text color={focused ? inkColors.primary : inkColors.rule}>{focused ? '▍' : ' '}</Text>
        <Text>
          {' '}
          <Text color={focused ? inkColors.primary : inkColors.muted} bold={focused}>
            {sprint.name}
          </Text>{' '}
          <StatusChip label={sprint.status} kind={sprintStatusKind(sprint.status)} />
          {isCurrent && (
            <Text dimColor italic>
              {' '}
              {glyphs.bullet} current
            </Text>
          )}
        </Text>
      </Box>
      {focused && (
        <Box paddingLeft={3}>
          <Text dimColor>
            {glyphs.activityArrow} {String(sprint.tickets.length)} ticket
            {sprint.tickets.length === 1 ? '' : 's'}
          </Text>
        </Box>
      )}
    </Box>
  );
};
