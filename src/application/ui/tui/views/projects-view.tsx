/**
 * Projects list — read-only enumeration of every project in storage. Selecting a row pushes
 * the project detail view to BROWSE it; browsing never switches the current selection (a
 * project switch clears the sprint cursor as a side effect, so a passive look-around must not
 * cost the user their working sprint). Press `m` on a focused row to make it current —
 * mirroring the sprint-detail view's explicit opt-in.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { Box, Text } from 'ink';
import { ViewShell } from '@src/application/ui/tui/components/view-shell.tsx';
import { useListWindow, OverflowRow, type ListWindow } from '@src/application/ui/tui/components/windowed-list.tsx';
import { AsyncListFrame } from '@src/application/ui/tui/components/async-list-frame.tsx';
import { EmptyState } from '@src/application/ui/tui/components/empty-state.tsx';
import { FeedbackLine } from '@src/application/ui/tui/components/feedback-line.tsx';
import { ListCard } from '@src/application/ui/tui/components/list-card.tsx';
import { plural } from '@src/application/ui/shared/plural.ts';
import { formatBytes } from '@src/application/ui/shared/format-bytes.ts';
import type { ProjectRemovalPreview } from '@src/application/flows/delete-project/project-removal.ts';
import { LoadingRow } from '@src/application/ui/tui/components/async-rows.tsx';
import { ConfirmCard } from '@src/application/ui/tui/components/confirm-card.tsx';
import { type Project, setProjectDisplayName } from '@src/domain/entity/project.ts';
import { useEditField } from '@src/application/ui/tui/runtime/use-edit-field.ts';
import { useIsMounted } from '@src/application/ui/tui/runtime/use-is-mounted.ts';
import { Result } from '@src/domain/result.ts';
import { glyphs, listCapacity, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { useDeps } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { useAsyncLoad, type AsyncLoadState } from '@src/application/ui/tui/runtime/use-async-load.ts';
import { useRouter } from '@src/application/ui/tui/runtime/router.tsx';
import { useSelection } from '@src/application/ui/tui/runtime/selection-context.tsx';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { useViewKeys, type ViewKeyBinding } from '@src/application/ui/tui/runtime/use-view-keys.ts';
import { createBindings, listMoveBinding } from '@src/application/ui/tui/runtime/keyboard-map.ts';
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
  handleDeleteConfirmed: (target: Project, confirmed: boolean, cascade: boolean) => Promise<void>;
} => {
  const deps = useDeps();
  const handleDeleteConfirmed = useCallback(
    async (target: Project, confirmed: boolean, cascade: boolean) => {
      if (!confirmed) return;
      const r = await deps.projectRemoval.remove(target.id, { cascade });
      if (!r.ok) {
        if (mountedRef.current) setFeedback(`${glyphs.cross} ${r.error.message}`);
        return;
      }
      // Clearing the deleted project's selection targets the always-mounted SelectionProvider, so it
      // runs unconditionally — the stale cursor must drop even if the operator navigated away mid-delete.
      if (selection.projectId === target.id) selection.setProject(undefined);
      if (!mountedRef.current) return;
      const alsoRemoved =
        cascade && (r.value.removedSprints > 0 || r.value.removedMemoryDirs > 0)
          ? ` and ${plural(r.value.removedSprints, 'sprint')}`
          : '';
      setFeedback(`${glyphs.check} removed ${target.displayName}${alsoRemoved}`);
      reload();
    },
    [deps, mountedRef, selection, setFeedback, reload]
  );
  return { handleDeleteConfirmed };
};

/** Private presentational component for a single project row. */
const ProjectRow = ({ project, focused }: { project: Project; focused: boolean }): React.JSX.Element => (
  <ListCard
    focused={focused}
    title={project.displayName}
    rightSlot={<Text dimColor>{plural(project.repositories.length, 'repo')}</Text>}
  >
    <Text dimColor wrap="truncate-end">
      {project.slug}
      {project.description !== undefined && project.description.length > 0
        ? ` ${glyphs.bullet} ${project.description}`
        : ''}
    </Text>
    {project.repositories.slice(0, 2).map((r) => (
      <Box key={r.id}>
        <Box flexShrink={0}>
          <Text dimColor>
            {glyphs.activityArrow} {r.name}{' '}
          </Text>
        </Box>
        <Text dimColor wrap="truncate-middle">
          {r.path}
        </Text>
      </Box>
    ))}
    {project.repositories.length > 2 && (
      <Text dimColor italic>
        +{String(project.repositories.length - 2)} more{' '}
        {project.repositories.length - 2 === 1 ? 'repository' : 'repositories'}
      </Text>
    )}
  </ListCard>
);

/**
 * Two-step removal gate: remove the project, then — only when it owns sprints or memory — ask
 * whether to take those too. Declining keeps today's behaviour (they become housekeeping orphans).
 */
const ProjectDeleteConfirm = ({
  project,
  onSubmit,
  onCancel,
}: {
  readonly project: Project;
  readonly onSubmit: (confirmed: boolean, cascade: boolean) => void;
  readonly onCancel: () => void;
}): React.JSX.Element => {
  const deps = useDeps();
  const [preview, setPreview] = useState<ProjectRemovalPreview | 'unavailable' | undefined>(undefined);
  const [step, setStep] = useState<'project' | 'children'>('project');

  useEffect(() => {
    let cancelled = false;
    void deps.projectRemoval.preview(project.id).then((r) => {
      if (!cancelled) setPreview(r.ok ? r.value : 'unavailable');
    });
    return () => {
      cancelled = true;
    };
  }, [deps.projectRemoval, project.id]);

  // Hold the card until the preview lands so a fast `y` can't skip the cascade question.
  if (preview === undefined) return <LoadingRow label="Checking what this removes…" />;
  const owned = preview !== 'unavailable' && (preview.sprints.length > 0 || preview.memoryDirs > 0);

  if (step === 'children' && preview !== 'unavailable') {
    return (
      <ConfirmCard
        key="children"
        verb="Also remove"
        target={`its ${plural(preview.sprints.length, 'sprint')} and memory`}
        body={
          <Text dimColor>
            Deletes {formatBytes(preview.bytes)} for good. No keeps them as orphans you can clear from System{' '}
            {glyphs.arrowRight} Housekeeping.
          </Text>
        }
        onSubmit={(cascade) => onSubmit(true, cascade)}
        onCancel={onCancel}
      />
    );
  }
  return (
    <ConfirmCard
      key="project"
      verb="Remove"
      target={`project "${project.displayName}"`}
      body={<Text dimColor>Repository contents on disk are not touched.</Text>}
      onSubmit={(yes) => (yes && owned ? setStep('children') : onSubmit(yes, false))}
      onCancel={onCancel}
    />
  );
};

interface ProjectsBodyProps {
  readonly confirmDelete: Project | undefined;
  readonly onDeleteSubmit: (confirmed: boolean, cascade: boolean) => void;
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
  // The delete gate takes over the whole frame; everything below it is the ordinary async ladder.
  const overlay =
    confirmDelete !== undefined ? (
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
            {glyphs.bullet} {plural(total, 'project')}
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
  listMoveBinding,
  { keys: ['↵'], hint: 'open' },
  {
    keys: ['m'],
    hint: 'current',
    run: () => {
      // Explicit make-current — switching projects clears the sprint cursor by design, so
      // this is the deliberate action, not a side effect of browsing.
      if (target !== undefined && currentProjectId !== target.id) {
        setProject(target.id, target.displayName);
        setFeedback(`${glyphs.check} now on ${target.displayName}`);
      }
    },
  },
  ...createBindings(pushCreateProject),
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
      router.push({ id: 'project-detail', props: { projectId: p.id, projectName: p.displayName } });
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
    <ViewShell title="Projects" subtitle="Browse, rename and switch projects" suppressScrollArrows>
      <ProjectsBody
        confirmDelete={confirmDelete}
        onDeleteSubmit={(value, cascade) => {
          const pending = confirmDelete;
          setConfirmDelete(undefined);
          if (pending !== undefined) void handleDeleteConfirmed(pending, value, cascade);
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
