/**
 * Project picker — first screen on every launch (when projects exist). Lists every project,
 * pre-selects the most recently used one, and routes to the home view on Enter. A `+ new
 * project` row at the top routes to the create-project wizard.
 *
 * The picker is intentionally separate from the read-only Projects view: this is the entry
 * surface where the user chooses *which project to work on for this session* and persists that
 * choice. The standard Projects view is for managing the project list itself.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { ViewShell } from '@src/application/ui/tui/components/view-shell.tsx';
import { Spinner } from '@src/application/ui/tui/components/spinner.tsx';
import { Card } from '@src/application/ui/tui/components/card.tsx';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { useDeps } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { useRouter } from '@src/application/ui/tui/runtime/router.tsx';
import { useSelection } from '@src/application/ui/tui/runtime/selection-context.tsx';
import { useAsyncLoad } from '@src/application/ui/tui/runtime/use-async-load.ts';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { useViewHints } from '@src/application/ui/tui/runtime/use-view-hints.tsx';
import { HelpOverlay } from '@src/application/ui/tui/components/help-overlay.tsx';
import type { Project } from '@src/domain/entity/project.ts';

export const PickProjectView = (): React.JSX.Element => {
  const deps = useDeps();
  const router = useRouter();
  const selection = useSelection();
  const ui = useUiState();
  useViewHints([
    { keys: '↵', label: 'use project' },
    { keys: '+', label: 'create new' },
    { keys: 'r', label: 'reload' },
  ]);

  const { state, reload } = useAsyncLoad<readonly Project[]>(async () => {
    const r = await deps.projectRepo.list();
    if (!r.ok) throw new Error(r.error.message);
    return r.value;
  }, []);

  const projects = state.kind === 'ok' ? state.value : [];

  // Pre-seed the cursor to the already-selected project (set by launch from the persisted
  // last-selection). On reload we re-cap the index against the current list length.
  const initialIdx = useMemo(() => {
    if (selection.projectId === undefined) return 0;
    const i = projects.findIndex((p) => p.id === selection.projectId);
    return i === -1 ? 0 : i;
  }, [projects, selection.projectId]);

  const [cursor, setCursor] = useState<number>(initialIdx);
  useEffect(() => {
    setCursor((c) => (c >= projects.length ? Math.max(0, projects.length - 1) : c));
  }, [projects.length]);
  useEffect(() => {
    setCursor(initialIdx);
  }, [initialIdx]);

  const pick = (project: Project): void => {
    selection.setProject(project.id, project.displayName);
    router.reset({ id: 'home' });
  };

  useInput((input, key) => {
    if (ui.helpOpen || ui.promptActive) return;
    if (key.upArrow || input === 'k') {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.downArrow || input === 'j') {
      setCursor((c) => Math.min(projects.length - 1, c + 1));
      return;
    }
    if (key.return) {
      const target = projects[cursor];
      if (target !== undefined) pick(target);
      return;
    }
    if (input === '+' || input === 'c') {
      router.push({ id: 'create-project' });
      return;
    }
    if (input === 'r') reload();
  });

  return (
    <ViewShell title="Pick a project" subtitle="The rest of the session targets the one you choose">
      {ui.helpOpen ? (
        <HelpOverlay />
      ) : state.kind === 'loading' || state.kind === 'idle' ? (
        <Box paddingX={spacing.indent}>
          <Spinner label="Loading projects…" />
        </Box>
      ) : state.kind === 'error' ? (
        <Box paddingX={spacing.indent}>
          <Text color={inkColors.error}>Failed to load projects.</Text>
        </Box>
      ) : projects.length === 0 ? (
        <Card title="▸ No projects yet" tone="primary">
          <Box flexDirection="column" paddingX={spacing.indent}>
            <Text>A project binds one or more repositories together. Press + to create one.</Text>
          </Box>
        </Card>
      ) : (
        <Box flexDirection="column">
          <Box paddingX={spacing.indent} marginBottom={spacing.section}>
            <Text dimColor>
              {String(projects.length)} project{projects.length === 1 ? '' : 's'} {glyphs.bullet}{' '}
              {selection.projectLabel !== undefined ? (
                <Text>
                  last used:{' '}
                  <Text color={inkColors.primary} bold>
                    {selection.projectLabel}
                  </Text>
                </Text>
              ) : (
                <Text>press ↵ to confirm</Text>
              )}
            </Text>
          </Box>
          <Box flexDirection="column">
            {projects.map((p, i) => {
              const focused = i === cursor;
              const isLast = selection.projectId === p.id;
              return (
                <Box key={p.id} flexDirection="column" paddingX={spacing.indent}>
                  <Box>
                    <Text color={focused ? inkColors.primary : inkColors.rule}>{focused ? '▍' : ' '}</Text>
                    <Text>
                      {' '}
                      <Text color={focused ? inkColors.primary : inkColors.muted} bold={focused}>
                        {p.displayName}
                      </Text>
                      {isLast && (
                        <Text dimColor italic>
                          {' '}
                          {glyphs.bullet} last used
                        </Text>
                      )}
                    </Text>
                  </Box>
                  {focused && (
                    <Box paddingLeft={3}>
                      <Text dimColor>
                        {glyphs.activityArrow} {p.slug} {glyphs.bullet} {String(p.repositories.length)} repo
                        {p.repositories.length === 1 ? '' : 's'}
                      </Text>
                    </Box>
                  )}
                </Box>
              );
            })}
          </Box>
          <Box marginTop={spacing.section} paddingX={spacing.indent}>
            <Text dimColor>
              {glyphs.bullet} ↵ use the highlighted project {glyphs.bullet} + create a new one
            </Text>
          </Box>
        </Box>
      )}
    </ViewShell>
  );
};
