/**
 * Projects list — read-only enumeration of every project in storage. Selecting a row pushes
 * the project detail view to BROWSE it; browsing never switches the current selection (a
 * project switch clears the sprint cursor as a side effect, so a passive look-around must not
 * cost the user their working sprint). Press `m` on a focused row to make it current —
 * mirroring the sprint-detail view's explicit opt-in.
 */

import React, { useState, useCallback } from 'react';
import { Box, Text } from 'ink';
import { ViewShell } from '@src/application/ui/tui/components/view-shell.tsx';
import { useListWindow, OverflowRow, type ListWindow } from '@src/application/ui/tui/components/windowed-list.tsx';
import { AsyncListFrame } from '@src/application/ui/tui/components/async-list-frame.tsx';
import { EmptyState } from '@src/application/ui/tui/components/empty-state.tsx';
import { FeedbackLine } from '@src/application/ui/tui/components/feedback-line.tsx';
import { ConfirmCard } from '@src/application/ui/tui/components/confirm-card.tsx';
import { type Project, setProjectDisplayName } from '@src/domain/entity/project.ts';
import { useEditField } from '@src/application/ui/tui/runtime/use-edit-field.ts';
import { useIsMounted } from '@src/application/ui/tui/runtime/use-is-mounted.ts';
import { Result } from '@src/domain/result.ts';
import { glyphs, inkColors, listCapacity, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { useDeps } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { useAsyncLoad, type AsyncLoadState } from '@src/application/ui/tui/runtime/use-async-load.ts';
import { useRouter } from '@src/application/ui/tui/runtime/router.tsx';
import { useSelection } from '@src/application/ui/tui/runtime/selection-context.tsx';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { useViewKeys, type ViewKeyBinding } from '@src/application/ui/tui/runtime/use-view-keys.ts';
import { HelpOverlay } from '@src/application/ui/tui/components/help-overlay.tsx';
import { useBreakpoint } from '@src/application/ui/tui/runtime/use-breakpoint.ts';

/**
 * Rendered height (rows) of one {@link ProjectRow} card at its typical size: border top, name,
 * slug/description, two repository lines, border bottom — plus the section margin below it.
 */
const ROW_HEIGHT = 5;

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
        successLabel: `${glyphs.check} renamed "${target.displayName}"`,
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

/** Destructive-delete gate for one project, naming what the removal leaves untouched. */
const ProjectDeleteConfirm = ({
  project,
  onSubmit,
  onCancel,
}: {
  readonly project: Project;
  readonly onSubmit: (confirmed: boolean) => void;
  readonly onCancel: () => void;
}): React.JSX.Element => (
  <ConfirmCard
    title={
      <Text>
        Remove project <Text bold>{project.displayName}</Text>?
      </Text>
    }
    body={<Text dimColor>Sprints and repository contents are not touched.</Text>}
    message="Delete?"
    onSubmit={onSubmit}
    onCancel={onCancel}
  />
);

interface ProjectsBodyProps {
  readonly helpOpen: boolean;
  readonly confirmDelete: Project | undefined;
  readonly onDeleteSubmit: (confirmed: boolean) => void;
  readonly onDeleteCancel: () => void;
  readonly state: AsyncLoadState<readonly Project[], unknown>;
  readonly window: ListWindow;
  readonly visibleItems: readonly Project[];
  readonly focusedId: Project['id'] | undefined;
  readonly total: number;
  readonly feedback: string | undefined;
}

/** Loading / error / overlay / empty / list-of-cards presentation — pure props in. */
const ProjectsBody = ({
  helpOpen,
  confirmDelete,
  onDeleteSubmit,
  onDeleteCancel,
  state,
  window,
  visibleItems,
  focusedId,
  total,
  feedback,
}: ProjectsBodyProps): React.JSX.Element => {
  // The help screen and the delete gate each take over the whole frame; everything below them is
  // the ordinary async ladder.
  const overlay = helpOpen ? (
    <HelpOverlay />
  ) : confirmDelete !== undefined ? (
    <ProjectDeleteConfirm project={confirmDelete} onSubmit={onDeleteSubmit} onCancel={onDeleteCancel} />
  ) : undefined;

  return (
    <AsyncListFrame
      {...(overlay !== undefined ? { overlay } : {})}
      state={state}
      loadingLabel="Loading projects…"
      errorMessage="Failed to load projects."
      isEmpty={total === 0}
      empty={
        <EmptyState
          title="No projects yet"
          hint="Press c to create the first one."
          action={`c ${glyphs.arrowRight} create  ${glyphs.bullet}  esc ${glyphs.arrowRight} back`}
        />
      }
    >
      <Box flexDirection="column">
        <OverflowRow direction="above" count={window.hiddenAbove} />
        {visibleItems.map((p) => (
          <ProjectRow key={p.id} project={p} focused={focusedId === p.id} />
        ))}
        <OverflowRow direction="below" count={window.hiddenBelow} />
        {/* Just the count — the key affordances live in the router's hint strip (`useViewKeys`),
          the single source of truth. A second hand-typed strip here would drift from it. */}
        <Box paddingX={spacing.indent} marginTop={spacing.section}>
          <Text dimColor>
            {glyphs.bullet} {total} project(s)
          </Text>
        </Box>
        <FeedbackLine text={feedback} />
      </Box>
    </AsyncListFrame>
  );
};

interface ProjectsKeysInput {
  /** The row the actions apply to — the cursor row, falling back to the first project. */
  readonly target: Project | undefined;
  readonly currentProjectId: Project['id'] | undefined;
  readonly setProject: (id: Project['id'], label: string) => void;
  readonly pushCreateProject: () => void;
  readonly handleRename: (target: Project) => void;
  readonly setConfirmDelete: (project: Project | undefined) => void;
  readonly setFeedback: (text: string | undefined) => void;
  readonly reload: () => void;
}

/** The project-list key map — every action reads the same focused row. */
const projectsKeyBindings = ({
  target,
  currentProjectId,
  setProject,
  pushCreateProject,
  handleRename,
  setConfirmDelete,
  setFeedback,
  reload,
}: ProjectsKeysInput): readonly ViewKeyBinding[] => [
  { keys: ['↑', '↓', 'j', 'k'], hint: 'move' },
  { keys: ['↵'], hint: 'open' },
  {
    keys: ['m'],
    hint: 'make current',
    run: () => {
      // Explicit make-current — switching projects clears the sprint cursor by design, so
      // this is the deliberate action, not a side effect of browsing.
      if (target !== undefined && currentProjectId !== target.id) {
        setProject(target.id, target.displayName);
        setFeedback(`${glyphs.check} now on ${target.displayName}`);
      }
    },
  },
  { keys: ['c'], hint: 'create', run: pushCreateProject },
  {
    keys: ['e'],
    hint: 'rename',
    run: () => {
      if (target !== undefined) handleRename(target);
    },
  },
  {
    keys: ['d'],
    hint: 'delete',
    run: () => {
      if (target !== undefined) setConfirmDelete(target);
    },
  },
  {
    keys: ['r'],
    hint: 'reload',
    run: () => {
      setFeedback(`${glyphs.refresh} reloading…`);
      reload();
    },
  },
];

export const ProjectsView = (): React.JSX.Element => {
  const router = useRouter();
  const selection = useSelection();
  const ui = useUiState();
  const { rows } = useBreakpoint();
  const edit = useEditField();
  const deps = useDeps();
  const mountedRef = useIsMounted();

  const [confirmDelete, setConfirmDelete] = useState<Project | undefined>(undefined);
  const [feedback, setFeedback] = useState<string | undefined>(undefined);

  const { state, reload } = useAsyncLoad<readonly Project[]>(async () => {
    const r = await deps.projectRepo.list();
    if (!r.ok) throw new Error(r.error.message);
    return r.value;
  }, []);

  const items = state.kind === 'ok' ? state.value : [];
  const listActive = !ui.modalOpen && confirmDelete === undefined;

  const { window, visibleItems, focusedItem } = useListWindow<Project>({
    items,
    getId: (p) => p.id,
    visibleRows: listCapacity(rows, { rowHeight: ROW_HEIGHT, min: 4, max: 12 }),
    active: listActive,
    onSubmit: (p) => {
      // Browse only — opening a detail view must not switch the selection (and wipe the
      // sprint cursor). `m` below is the explicit make-current action.
      router.push({ id: 'project-detail', props: { projectId: p.id } });
    },
  });

  const handleRename = useRenameProjectAction(edit, selection, setFeedback, reload);
  const { handleDeleteConfirmed } = useDeleteProjectAction(selection, mountedRef, setFeedback, reload);
  const target = focusedItem ?? items[0];

  useViewKeys(
    projectsKeyBindings({
      target,
      currentProjectId: selection.projectId,
      setProject: (id, label) => selection.setProject(id, label),
      pushCreateProject: () => router.push({ id: 'create-project' }),
      handleRename,
      setConfirmDelete,
      setFeedback,
      reload,
    }),
    { active: listActive }
  );

  return (
    <ViewShell title="Projects" subtitle="Browse projects — press m to make one current" suppressScrollArrows>
      <ProjectsBody
        helpOpen={ui.helpOpen}
        confirmDelete={confirmDelete}
        onDeleteSubmit={(value) => {
          const pending = confirmDelete;
          setConfirmDelete(undefined);
          if (pending !== undefined) void handleDeleteConfirmed(pending, value);
        }}
        onDeleteCancel={() => setConfirmDelete(undefined)}
        state={state}
        window={window}
        visibleItems={visibleItems}
        focusedId={focusedItem?.id}
        total={items.length}
        feedback={feedback ?? edit.feedback}
      />
    </ViewShell>
  );
};
