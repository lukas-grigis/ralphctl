/**
 * Projects list — read-only enumeration of every project in storage. Selecting a row pushes
 * the project detail view to BROWSE it; browsing never switches the current selection (a
 * project switch clears the sprint cursor as a side effect, so a passive look-around must not
 * cost the user their working sprint). Press `m` on a focused row to make it current —
 * mirroring the sprint-detail view's explicit opt-in.
 */

import React, { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import { ViewShell } from '@src/application/ui/tui/components/view-shell.tsx';
import { useListWindow, OverflowRow } from '@src/application/ui/tui/components/windowed-list.tsx';
import { EmptyState } from '@src/application/ui/tui/components/empty-state.tsx';
import { LoadErrorRow, LoadingRow } from '@src/application/ui/tui/components/async-rows.tsx';
import { FeedbackLine } from '@src/application/ui/tui/components/feedback-line.tsx';
import { ConfirmCard } from '@src/application/ui/tui/components/confirm-card.tsx';
import { type Project, setProjectDisplayName } from '@src/domain/entity/project.ts';
import { useEditField } from '@src/application/ui/tui/runtime/use-edit-field.ts';
import { useIsMounted } from '@src/application/ui/tui/runtime/use-is-mounted.ts';
import { Result } from '@src/domain/result.ts';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { useDeps } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { useAsyncLoad } from '@src/application/ui/tui/runtime/use-async-load.ts';
import { useRouter } from '@src/application/ui/tui/runtime/router.tsx';
import { useSelection } from '@src/application/ui/tui/runtime/selection-context.tsx';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { useViewHints } from '@src/application/ui/tui/runtime/use-view-hints.tsx';
import { HelpOverlay } from '@src/application/ui/tui/components/help-overlay.tsx';
import { useBreakpoint } from '@src/application/ui/tui/runtime/use-breakpoint.ts';

/** Private hook for rename action. */
const useRenameProjectAction = (
  edit: ReturnType<typeof useEditField>,
  selection: ReturnType<typeof useSelection>,
  setFeedback: (msg: string | undefined) => void,
  reload: () => void
): ((target: Project) => void) => {
  const deps = useDeps();
  return useCallback(
    (target: Project) => {
      setFeedback(undefined);
      void edit.openEditPrompt({
        title: `Rename project "${target.displayName}"`,
        kind: 'short',
        currentValue: target.displayName,
        onSave: async (value) => {
          const renamed = setProjectDisplayName(target, value);
          if (!renamed.ok) return Result.error(renamed.error);
          const saved = await deps.projectRepo.save(renamed.value);
          if (!saved.ok) return Result.error(saved.error);
          if (selection.projectId === target.id) selection.setProject(target.id, renamed.value.displayName);
          reload();
          return Result.ok(undefined);
        },
        successLabel: `✓ renamed "${target.displayName}"`,
      });
    },
    [edit, selection, deps, reload, setFeedback]
  );
};

/** Private hook for delete action. */
const useDeleteProjectAction = (
  selection: ReturnType<typeof useSelection>,
  mountedRef: ReturnType<typeof useIsMounted>,
  setFeedback: (msg: string | undefined) => void,
  reload: () => void
): {
  handleDeleteConfirmed: (target: Project, confirmed: boolean) => Promise<void>;
} => {
  const deps = useDeps();
  const handleDeleteConfirmed = useCallback(
    async (target: Project, confirmed: boolean) => {
      if (!confirmed) return;
      const r = await deps.projectRepo.remove(target.id);
      if (!r.ok) {
        if (mountedRef.current) setFeedback(`${glyphs.cross} ${r.error.message}`);
        return;
      }
      // Clearing the deleted project's selection targets the always-mounted SelectionProvider, so it
      // runs unconditionally — the stale cursor must drop even if the operator navigated away mid-delete.
      if (selection.projectId === target.id) selection.setProject(undefined);
      if (!mountedRef.current) return;
      setFeedback(`${glyphs.check} removed ${target.displayName}`);
      reload();
    },
    [deps, mountedRef, selection, setFeedback, reload]
  );
  return { handleDeleteConfirmed };
};

/** Private presentational component for a single project row. */
const ProjectRow = ({ project, focused }: { project: Project; focused: boolean }): React.JSX.Element => (
  <Box key={project.id} flexDirection="column" marginBottom={spacing.section}>
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={focused ? inkColors.primary : inkColors.rule}
      borderDimColor={!focused}
      paddingX={spacing.cardPadX}
    >
      <Box justifyContent="space-between">
        <Text bold {...(focused ? { color: inkColors.primary } : {})}>
          {project.displayName}
        </Text>
        <Text dimColor>
          {String(project.repositories.length)} repo{project.repositories.length === 1 ? '' : 's'}
        </Text>
      </Box>
      <Text dimColor>
        {project.slug}
        {project.description !== undefined && project.description.length > 0
          ? ` ${glyphs.bullet} ${project.description}`
          : ''}
      </Text>
      {project.repositories.slice(0, 2).map((r) => (
        <Text key={r.id} dimColor>
          {glyphs.activityArrow} {r.name} <Text dimColor>{r.path}</Text>
        </Text>
      ))}
      {project.repositories.length > 2 && (
        <Text dimColor italic>
          +{String(project.repositories.length - 2)} more{' '}
          {project.repositories.length - 2 === 1 ? 'repository' : 'repositories'}
        </Text>
      )}
    </Box>
  </Box>
);

export const ProjectsView = (): React.JSX.Element => {
  const router = useRouter();
  const selection = useSelection();
  const ui = useUiState();
  const { rows } = useBreakpoint();
  const edit = useEditField();
  const deps = useDeps();
  const mountedRef = useIsMounted();

  useViewHints([
    { keys: '↑/↓/j/k', label: 'move' },
    { keys: '↵', label: 'open' },
    { keys: 'm', label: 'make current' },
    { keys: 'c', label: 'create' },
    { keys: 'e', label: 'rename' },
    { keys: 'd', label: 'delete' },
    { keys: 'r', label: 'reload' },
  ]);

  const [confirmDelete, setConfirmDelete] = useState<Project | undefined>(undefined);
  const [feedback, setFeedback] = useState<string | undefined>(undefined);

  const { state, reload } = useAsyncLoad<readonly Project[]>(async () => {
    const r = await deps.projectRepo.list();
    if (!r.ok) throw new Error(r.error.message);
    return r.value;
  }, []);

  const items = state.kind === 'ok' ? state.value : [];
  const listActive = !ui.modalOpen && confirmDelete === undefined;
  const visibleRows = Math.max(4, Math.min(12, Math.floor(rows / 5)));

  const { window, visibleItems, focusedItem } = useListWindow<Project>({
    items,
    getId: (p) => p.id,
    visibleRows,
    active: listActive,
    onSubmit: (p) => {
      // Browse only — opening a detail view must not switch the selection (and wipe the
      // sprint cursor). `m` below is the explicit make-current action.
      router.push({ id: 'project-detail', props: { projectId: p.id } });
    },
  });

  const handleRename = useRenameProjectAction(edit, selection, setFeedback, reload);
  const { handleDeleteConfirmed } = useDeleteProjectAction(selection, mountedRef, setFeedback, reload);

  useInput((input) => {
    if (ui.modalOpen || confirmDelete !== undefined) return;
    if (input === 'c') {
      router.push({ id: 'create-project' });
      return;
    }
    if (input === 'm') {
      // Explicit make-current — switching projects clears the sprint cursor by design, so
      // this is the deliberate action, not a side effect of browsing.
      const target = focusedItem ?? items[0];
      if (target !== undefined && selection.projectId !== target.id) {
        selection.setProject(target.id, target.displayName);
        setFeedback(`${glyphs.check} now on ${target.displayName}`);
      }
      return;
    }
    if (input === 'e') {
      const target = focusedItem ?? items[0];
      if (target !== undefined) handleRename(target);
      return;
    }
    if (input === 'd') {
      const target = focusedItem ?? items[0];
      if (target !== undefined) setConfirmDelete(target);
      return;
    }
    if (input === 'r') {
      setFeedback(`${glyphs.refresh} reloading…`);
      reload();
    }
  });

  return (
    <ViewShell title="Projects" subtitle="Browse projects — press m to make one current" suppressScrollArrows>
      {ui.helpOpen ? (
        <HelpOverlay />
      ) : state.kind === 'loading' || state.kind === 'idle' ? (
        <LoadingRow label="Loading projects…" />
      ) : state.kind === 'error' ? (
        <LoadErrorRow message="Failed to load projects." />
      ) : confirmDelete !== undefined ? (
        <ConfirmCard
          title={
            <Text>
              Remove project <Text bold>{confirmDelete.displayName}</Text>?
            </Text>
          }
          body={<Text dimColor>Sprints and repository contents are not touched.</Text>}
          message="Delete?"
          onSubmit={(value) => {
            const target = confirmDelete;
            setConfirmDelete(undefined);
            void handleDeleteConfirmed(target, value);
          }}
          onCancel={() => setConfirmDelete(undefined)}
        />
      ) : state.value.length === 0 ? (
        <EmptyState
          title="No projects yet"
          hint="Press c to create the first one."
          action={`c ${glyphs.arrowRight} create  ${glyphs.bullet}  esc ${glyphs.arrowRight} back`}
        />
      ) : (
        <Box flexDirection="column">
          <OverflowRow direction="above" count={window.start} />
          {visibleItems.map((p) => (
            <ProjectRow key={p.id} project={p} focused={focusedItem?.id === p.id} />
          ))}
          <OverflowRow direction="below" count={state.value.length - window.end} />
          <Box paddingX={spacing.indent} marginTop={spacing.section}>
            <Text dimColor>
              {glyphs.bullet} {state.value.length} project(s) {glyphs.bullet} ↑/↓ move {glyphs.bullet} ↵ open{' '}
              {glyphs.bullet} m make current {glyphs.bullet} c create {glyphs.bullet} e rename {glyphs.bullet} d delete{' '}
              {glyphs.bullet} r reload
            </Text>
          </Box>
          <FeedbackLine text={feedback ?? edit.feedback} />
        </Box>
      )}
    </ViewShell>
  );
};
