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
import { launchFlow, sessionHintsFromLaunchResult } from '@src/application/ui/shared/launcher.ts';
import { loadAppStateSnapshot } from '@src/application/ui/shared/state-snapshot.ts';
import { HelpOverlay } from '@src/application/ui/tui/components/help-overlay.tsx';
import type { Project } from '@src/domain/entity/project.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';

const UNKNOWN_PROJECT_KEY = '__unknown__';
const UNKNOWN_PROJECT_LABEL = 'Unknown project';

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

type FlatRow = HeaderRow | SprintRow;

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

/** Flatten groups into the cursor-navigable row list. Empty groups still emit a header. */
const flatten = (groups: readonly SprintGroup[]): readonly FlatRow[] => {
  const rows: FlatRow[] = [];
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

/** Indices of the rows the cursor is allowed to land on (sprint rows only). */
const sprintRowIndices = (rows: readonly FlatRow[]): readonly number[] => {
  const indices: number[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i]?.kind === 'sprint') indices.push(i);
  }
  return indices;
};

const nextSprintIndex = (rows: readonly FlatRow[], from: number, direction: 1 | -1): number => {
  const candidates = sprintRowIndices(rows);
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

  const { state, reload } = useAsyncLoad<PickerData>(async () => {
    const [sprintsR, projectsR] = await Promise.all([deps.sprintRepo.list(), deps.projectRepo.list()]);
    if (!sprintsR.ok) throw new Error(sprintsR.error.message);
    if (!projectsR.ok) throw new Error(projectsR.error.message);
    const projectsById = new Map<ProjectId, Project>();
    for (const p of projectsR.value) projectsById.set(p.id, p);
    return { sprints: sprintsR.value, projectsById };
  }, []);

  const data: PickerData = state.kind === 'ok' ? state.value : { sprints: [], projectsById: new Map() };

  const groups = useMemo(() => buildGroups(data, selection.projectId, scopeAll), [data, selection.projectId, scopeAll]);
  const rows = useMemo(() => flatten(groups), [groups]);
  const sprintCount = useMemo(() => rows.reduce((acc, r) => (r.kind === 'sprint' ? acc + 1 : acc), 0), [rows]);

  // Pre-seed the cursor to the already-selected sprint so Enter is a one-keystroke confirm.
  const initialIdx = useMemo(() => {
    if (selection.sprintId !== undefined) {
      const i = rows.findIndex((r) => r.kind === 'sprint' && r.sprint.id === selection.sprintId);
      if (i !== -1) return i;
    }
    return sprintRowIndices(rows)[0] ?? 0;
  }, [rows, selection.sprintId]);

  const [cursor, setCursor] = useState<number>(initialIdx);
  useEffect(() => {
    setCursor((c) => {
      if (rows.length === 0) return 0;
      if (c >= rows.length) return Math.max(0, rows.length - 1);
      // Snap cursor back onto a sprint row if a re-group landed it on a header.
      if (rows[c]?.kind !== 'sprint') {
        return sprintRowIndices(rows)[0] ?? c;
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

  // Same launcher dance as sprints-view.tsx — keeps create-sprint's prompt + session wiring
  // in a single place. Failures surface inline; success pushes the execute view.
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
    const result = await launchFlow(
      { app: deps, interactive, storage, runInTerminal: getRunInTerminal() },
      'create-sprint',
      snapshot
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
    // Recompute the cursor to land on the selected sprint in the new list, if present;
    // otherwise on the first sprint row, or 0 if there are none.
    const nextRows = flatten(buildGroups(data, selection.projectId, next));
    let idx = -1;
    if (selection.sprintId !== undefined) {
      idx = nextRows.findIndex((r) => r.kind === 'sprint' && r.sprint.id === selection.sprintId);
    }
    if (idx === -1) idx = sprintRowIndices(nextRows)[0] ?? 0;
    setCursor(idx);
  };

  useInput((input, key) => {
    if (ui.helpOpen || ui.promptActive) return;
    if (key.upArrow || input === 'k') {
      setCursor((c) => nextSprintIndex(rows, c, -1));
      return;
    }
    if (key.downArrow || input === 'j') {
      setCursor((c) => nextSprintIndex(rows, c, 1));
      return;
    }
    if (key.return) {
      const row = rows[cursor];
      if (row?.kind === 'sprint') pick(row.sprint);
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
          <Box flexDirection="column">
            {rows.map((row, i) =>
              row.kind === 'header' ? (
                <HeaderRowView key={`h-${row.groupKey}`} row={row} />
              ) : (
                <SprintRowView
                  key={row.sprint.id}
                  sprint={row.sprint}
                  focused={i === cursor}
                  isCurrent={selection.sprintId === row.sprint.id}
                />
              )
            )}
          </Box>
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
