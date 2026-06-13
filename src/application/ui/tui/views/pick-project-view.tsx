/**
 * Project picker — first screen on every launch (when projects exist). Lists every project,
 * pre-selects the most recently used one, and routes to the home view on Enter. A `+ new
 * project` row at the top routes to the create-project wizard.
 *
 * The picker is intentionally separate from the read-only Projects view: this is the entry
 * surface where the user chooses *which project to work on for this session* and persists that
 * choice. The standard Projects view is for managing the project list itself.
 *
 * The list is windowed via {@link useListWindow} (cursor keyed on `project.id`) so the focused
 * project stays visible with ▴/▾ overflow cues even past the viewport — the prior flat render
 * hid lower rows from arrow / vim navigation on long project lists.
 */

import React, { useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { ViewShell } from '@src/application/ui/tui/components/view-shell.tsx';
import { Spinner } from '@src/application/ui/tui/components/spinner.tsx';
import { Card } from '@src/application/ui/tui/components/card.tsx';
import { OverflowRow, useListWindow } from '@src/application/ui/tui/components/windowed-list.tsx';
import { glyphs, inkColors, responsive, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { useDeps } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { useRouter } from '@src/application/ui/tui/runtime/router.tsx';
import { useSelection } from '@src/application/ui/tui/runtime/selection-context.tsx';
import { useAsyncLoad } from '@src/application/ui/tui/runtime/use-async-load.ts';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { useViewHints } from '@src/application/ui/tui/runtime/use-view-hints.tsx';
import { useBreakpoint } from '@src/application/ui/tui/runtime/use-breakpoint.ts';
import { HelpOverlay } from '@src/application/ui/tui/components/help-overlay.tsx';
import type { Project } from '@src/domain/entity/project.ts';

const projectIdOf = (p: Project): string => p.id;

interface ProjectListProps {
  readonly projects: readonly Project[];
  readonly active: boolean;
  readonly visibleRows: number;
  readonly selectedId: string | undefined;
  readonly selectedLabel: string | undefined;
  readonly initialCursorId: string | undefined;
  readonly onPick: (project: Project) => void;
}

/**
 * The windowed project list. Extracted so the parent can remount it via a `key` tied to the
 * persisted selection — that re-seeds the cursor when the last-used project arrives after first
 * render (mirrors the old `useEffect(() => setCursor(initialIdx), [initialIdx])` re-sync), while
 * {@link useListWindow} owns the cursor + nav keys thereafter.
 */
const ProjectList = ({
  projects,
  active,
  visibleRows,
  selectedId,
  selectedLabel,
  initialCursorId,
  onPick,
}: ProjectListProps): React.JSX.Element => {
  const { window, visibleItems, focusedItem } = useListWindow<Project>({
    items: projects,
    getId: projectIdOf,
    visibleRows,
    active,
    onSubmit: onPick,
    ...(initialCursorId !== undefined ? { initialCursorId } : {}),
  });

  return (
    <Box flexDirection="column">
      <Box paddingX={spacing.indent} marginBottom={spacing.section}>
        <Text dimColor>
          {String(projects.length)} project{projects.length === 1 ? '' : 's'} {glyphs.bullet}{' '}
          {selectedLabel !== undefined ? (
            <Text>
              last used:{' '}
              <Text color={inkColors.primary} bold>
                {selectedLabel}
              </Text>
            </Text>
          ) : (
            <Text>press ↵ to confirm</Text>
          )}
        </Text>
      </Box>
      <Box flexDirection="column">
        <OverflowRow direction="above" count={window.start} />
        {visibleItems.map((p) => {
          const focused = focusedItem !== undefined && p.id === focusedItem.id;
          const isLast = selectedId === p.id;
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
        <OverflowRow direction="below" count={projects.length - window.end} />
      </Box>
      <Box marginTop={spacing.section} paddingX={spacing.indent}>
        <Text dimColor>
          {glyphs.bullet} ↵ use the highlighted project {glyphs.bullet} + create a new one
        </Text>
      </Box>
    </Box>
  );
};

export const PickProjectView = (): React.JSX.Element => {
  const deps = useDeps();
  const router = useRouter();
  const selection = useSelection();
  const ui = useUiState();
  const { columns } = useBreakpoint();
  useViewHints([
    { keys: '↑/↓', label: 'move' },
    { keys: '↵', label: 'use project' },
    { keys: '+', label: 'create new' },
    { keys: 'r', label: 'reload' },
  ]);

  const { state, reload } = useAsyncLoad<readonly Project[]>(async () => {
    const r = await deps.projectRepo.list();
    if (!r.ok) throw new Error(r.error.message);
    return r.value;
  }, []);

  // Stable identity for the loading-state fallback so the downstream memo keyed on `projects`
  // doesn't re-run on every render while loading.
  const projects = useMemo(() => (state.kind === 'ok' ? state.value : []), [state]);

  // The picker owns its list cursor, so the page ScrollRegion must not also grab the arrows.
  const listActive = !ui.modalOpen && projects.length > 0;

  // Each unfocused project is one row; the focused one adds a detail sub-line. Window count is
  // generous on tall terminals and clamps down on short ones so the focused row + its detail and
  // the overflow cues always fit. Reserve ~10 rows for banner / breadcrumb / stamp / footer hint.
  const visibleRows = useMemo(() => responsive(columns, { sm: 8, md: 10, lg: 12, xl: 14 }), [columns]);

  const pick = (project: Project): void => {
    selection.setProject(project.id, project.displayName);
    router.reset({ id: 'home' });
  };

  // Non-navigation keys only — the windowed-list hook owns ↑/↓/j/k/PgUp/PgDn/Home/End/Enter.
  useInput((input) => {
    if (ui.modalOpen) return;
    if (input === '+' || input === 'c') {
      router.push({ id: 'create-project' });
      return;
    }
    if (input === 'r') reload();
  });

  return (
    <ViewShell
      title="Pick a project"
      subtitle="The rest of the session targets the one you choose"
      suppressScrollArrows
    >
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
        // Remount on a persisted-selection change so the cursor re-seeds to the last-used project
        // even if that selection arrives after the first render (launch sets it before mount in
        // production; the seed can lag by a tick under async wiring).
        <ProjectList
          key={selection.projectId ?? 'unseeded'}
          projects={projects}
          active={listActive}
          visibleRows={visibleRows}
          selectedId={selection.projectId}
          selectedLabel={selection.projectLabel}
          initialCursorId={selection.projectId}
          onPick={pick}
        />
      )}
    </ViewShell>
  );
};
