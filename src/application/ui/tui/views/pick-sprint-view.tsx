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
 *
 * List shaping (group/flatten/cursor walk) lives under `pick-sprint-internals/`; this file is
 * the orchestrator that wires data → hooks → row presentation.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { ViewShell } from '@src/application/ui/tui/components/view-shell.tsx';
import { Spinner } from '@src/application/ui/tui/components/spinner.tsx';
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
import type { PickerData } from '@src/application/ui/tui/views/pick-sprint-internals/types.ts';
import {
  buildGroups,
  cursorableRowIndices,
  flatten,
  nextCursorableIndex,
} from '@src/application/ui/tui/views/pick-sprint-internals/group-builder.ts';
import {
  MIN_VISIBLE_ROWS,
  VERTICAL_CHROME_ROWS,
  computeWindow,
} from '@src/application/ui/tui/views/pick-sprint-internals/window.ts';
import { RowWindowView } from '@src/application/ui/tui/views/pick-sprint-internals/row-views.tsx';

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
