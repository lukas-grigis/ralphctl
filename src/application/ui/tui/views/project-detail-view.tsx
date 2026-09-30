/**
 * Project detail — info card + repository roster + per-repo health (paths + scripts).
 *
 * Opening the detail is a BROWSE — it never switches the current selection (a project switch
 * clears the sprint cursor as a side effect). Press `m` to make the viewed project current,
 * mirroring the sprint-detail view's explicit opt-in.
 *
 * Every local key is declared once through `useViewKeys`, which also claims the printable ones —
 * `S` (detect skills) therefore never also opens the global sprint picker.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Text } from 'ink';
import { ViewShell } from '@src/application/ui/tui/components/view-shell.tsx';
import { LoadErrorRow, LoadingRow } from '@src/application/ui/tui/components/async-rows.tsx';
import { ConfirmCard } from '@src/application/ui/tui/components/confirm-card.tsx';
import { type Project, removeRepository, setProjectDisplayName, updateRepository } from '@src/domain/entity/project.ts';
import type { Repository } from '@src/domain/entity/repository.ts';
import { setRepositorySetupScript, setRepositoryVerifyScript } from '@src/domain/entity/repository.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import { Result } from '@src/domain/result.ts';
import { type OpenEditPromptInput, useEditField } from '@src/application/ui/tui/runtime/use-edit-field.ts';
import { useIsMounted } from '@src/application/ui/tui/runtime/use-is-mounted.ts';
import { useDeps } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { useAsyncLoad } from '@src/application/ui/tui/runtime/use-async-load.ts';
import type { AsyncLoadState } from '@src/application/ui/tui/runtime/use-async-load.ts';
import { useRouter, useViewProps } from '@src/application/ui/tui/runtime/router.tsx';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { useSelection } from '@src/application/ui/tui/runtime/selection-context.tsx';
import { useViewKeys } from '@src/application/ui/tui/runtime/use-view-keys.ts';
import { listMoveBinding } from '@src/application/ui/tui/runtime/keyboard-map.ts';
import { useSessionManager } from '@src/application/ui/tui/runtime/sessions-context.tsx';
import { usePromptQueue } from '@src/application/ui/tui/prompts/prompt-context.tsx';
import { createInkInteractivePrompt } from '@src/application/ui/tui/prompts/ink-interactive-prompt.ts';
import { useStorage } from '@src/application/ui/tui/runtime/storage-context.tsx';
import { getRunInTerminal } from '@src/application/ui/tui/runtime/run-in-terminal.ts';
import { openFlowSession } from '@src/application/ui/tui/runtime/open-flow-session.ts';
import { launchFlow } from '@src/application/ui/shared/launcher.ts';
import { loadAppStateSnapshot } from '@src/application/ui/shared/state-snapshot.ts';
import { Body } from '@src/application/ui/tui/views/project-detail-internals/field-groups.tsx';

interface ProjectDetailProps extends Readonly<Record<string, unknown>> {
  readonly projectId: ProjectId;
}

type RepoFieldKey = 'name' | 'setupScript' | 'verifyScript';
export type Field =
  | { readonly kind: 'project'; readonly field: 'displayName' }
  | { readonly kind: 'repo'; readonly field: RepoFieldKey; readonly repo: Repository };

type EditTarget =
  { readonly kind: 'project' } | { readonly kind: 'repo'; readonly field: RepoFieldKey; readonly repo: Repository };

/**
 * Once the project loads, refresh the display-name label in the selection cache so the status
 * bar can show "proj: <name>" without re-loading the aggregate — but ONLY for the project that
 * is already current. Re-stamping a *different* project here would switch the selection (and
 * clear the sprint cursor) as a side effect of merely browsing its detail; the explicit `m`
 * chord is the only path that switches.
 */
const useSyncCurrentProjectLabel = (
  state: AsyncLoadState<Project, unknown>,
  selection: ReturnType<typeof useSelection>
): void => {
  const setProjectRef = React.useRef(selection.setProject);
  setProjectRef.current = selection.setProject;
  const selectionProjectIdRef = React.useRef(selection.projectId);
  selectionProjectIdRef.current = selection.projectId;
  React.useEffect(() => {
    if (state.kind !== 'ok') return;
    if (selectionProjectIdRef.current === state.value.id) {
      setProjectRef.current(state.value.id, state.value.displayName);
    }
  }, [state]);
};

interface BuildFieldEditArgs {
  readonly target: EditTarget;
  readonly project: Project;
  readonly projectRepo: ReturnType<typeof useDeps>['projectRepo'];
  readonly reload: () => void;
}

/** Build the edit-prompt config for the focused row — the project's displayName or one repo
 *  field. Takes the entity + repo port as explicit args instead of closing over them so it can
 *  live outside the component's render scope. */
const buildFieldEdit = (args: BuildFieldEditArgs): OpenEditPromptInput => {
  const { target, project, projectRepo, reload } = args;
  if (target.kind === 'project') {
    return {
      title: `Rename project "${project.displayName}"`,
      kind: 'short',
      currentValue: project.displayName,
      onSave: async (value) => {
        const renamed = setProjectDisplayName(project, value);
        if (!renamed.ok) return Result.error(renamed.error);
        const saved = await projectRepo.save(renamed.value);
        if (!saved.ok) return Result.error(saved.error);
        reload();
        return Result.ok(undefined);
      },
      successLabel: `✓ renamed project`,
    };
  }
  const { repo, field } = target;
  const label = field === 'name' ? `Rename repository "${repo.name}"` : `Edit ${field} for "${repo.name}"`;
  const current =
    field === 'name' ? repo.name : field === 'setupScript' ? (repo.setupScript ?? '') : (repo.verifyScript ?? '');
  return {
    title: label,
    kind: field === 'name' ? 'short' : 'long',
    currentValue: current,
    onSave: async (value) => {
      // For optional script fields, route through the setter directly so `value === ''`
      // explicitly *clears* the field (the entity setter accepts `undefined` for clear).
      // `updateRepository`'s partial type — with exactOptionalPropertyTypes — disallows
      // direct undefined assignment, so we update the repo and persist the parent project.
      if (field === 'name') {
        const next = updateRepository(project, repo.id, { name: value });
        if (!next.ok) return Result.error(next.error);
        const saved = await projectRepo.save(next.value);
        if (!saved.ok) return Result.error(saved.error);
        reload();
        return Result.ok(undefined);
      }
      const updatedRepo =
        field === 'setupScript'
          ? setRepositorySetupScript(repo, value.length === 0 ? undefined : value)
          : setRepositoryVerifyScript(repo, value.length === 0 ? undefined : value);
      if (!updatedRepo.ok) return Result.error(updatedRepo.error);
      const nextRepos = project.repositories.map((r) => (r.id === repo.id ? updatedRepo.value : r));
      const saved = await projectRepo.save({ ...project, repositories: nextRepos });
      if (!saved.ok) return Result.error(saved.error);
      reload();
      return Result.ok(undefined);
    },
    successLabel: `✓ updated ${field}`,
  };
};

interface LaunchPerRepoFlowCtx {
  readonly deps: ReturnType<typeof useDeps>;
  readonly queue: ReturnType<typeof usePromptQueue>;
  readonly storage: ReturnType<typeof useStorage>;
  readonly sessions: ReturnType<typeof useSessionManager>;
  readonly router: ReturnType<typeof useRouter>;
  readonly mountedRef: ReturnType<typeof useIsMounted>;
  readonly setFeedback: (message: string | undefined) => void;
}

/**
 * Launch the `detect-scripts` / `detect-skills` one-shot flow scoped to a single repository.
 * `c`/`S` don't claim the global key-mute, so the operator can navigate away (unmounting this
 * view) while the launcher resolves — the mounted-ref guard skips the post-await view-local
 * writes (setFeedback / session open) so neither fires into an unmounted tree.
 */
const launchPerRepoFlow = async (
  ctx: LaunchPerRepoFlowCtx,
  project: Project | undefined,
  flowId: 'detect-scripts' | 'detect-skills',
  target: Repository
): Promise<void> => {
  if (project === undefined) return;
  const { deps, queue, storage, sessions, router, mountedRef, setFeedback } = ctx;
  setFeedback(undefined);
  const snapshot = await loadAppStateSnapshot(deps, { projectId: project.id });
  const interactive = createInkInteractivePrompt(queue);
  const result = await launchFlow(
    { app: deps, interactive, storage, runInTerminal: getRunInTerminal() },
    flowId,
    snapshot,
    { repositoryId: target.id }
  );
  if (!mountedRef.current) return;
  if (!result.ok) {
    setFeedback(`✗ ${result.reason}`);
    return;
  }
  openFlowSession({ sessions, router }, result, flowId);
};

interface ProjectDetailShortcutArgs extends LaunchPerRepoFlowCtx {
  readonly ui: ReturnType<typeof useUiState>;
  readonly selection: ReturnType<typeof useSelection>;
  readonly edit: ReturnType<typeof useEditField>;
  readonly project: Project | undefined;
  readonly focused: Field | undefined;
  readonly fieldsLength: number;
  readonly confirmRemove: Repository | undefined;
  readonly setCursorIdx: React.Dispatch<React.SetStateAction<number>>;
  readonly setConfirmRemove: (repo: Repository | undefined) => void;
  readonly reload: () => void;
}

/**
 * Keymap hook for the project-detail view — encapsulates every `useInput` chord (add repo, mark
 * current, edit field, flat-cursor navigation, per-repo CRUD + detect flows, sprints shortcut)
 * so the orchestrator only has to wire state and setters. Mirrors `useSprintDetailShortcuts` on
 * the sibling sprint-detail view. Extends {@link LaunchPerRepoFlowCtx} — `args` doubles as that
 * context for the two detect-flow chords, so no separate object needs assembling.
 */
const useProjectDetailShortcuts = (args: ProjectDetailShortcutArgs): void => {
  const { deps, router, ui, selection, edit, project, focused, reload } = args;

  const handleEdit = (): void => {
    if (project === undefined || focused === undefined) return;
    args.setFeedback(undefined);
    const target: EditTarget =
      focused.kind === 'project' ? { kind: 'project' } : { kind: 'repo', field: focused.field, repo: focused.repo };
    const cfg = buildFieldEdit({ target, project, projectRepo: deps.projectRepo, reload });
    void edit.openEditPrompt(cfg);
  };

  // Explicit "make this project current" — the deliberate counterpart to the browse-only open.
  // No-op if already current so re-pressing doesn't churn feedback.
  const markCurrent = (target: Project): void => {
    if (selection.projectId === target.id) return;
    selection.setProject(target.id, target.displayName);
    args.setFeedback(`✓ now on ${target.displayName}`);
  };

  const focusedRepo = focused?.kind === 'repo' ? focused.repo : undefined;
  const moveCursor = (delta: 1 | -1): void => {
    args.setCursorIdx((c) => Math.max(0, Math.min(Math.max(0, args.fieldsLength - 1), c + delta)));
  };

  useViewKeys(
    [
      listMoveBinding,
      {
        keys: ['↑', '↓', 'j', 'k'],
        hint: 'move',
        hidden: true,
        run: (input, key) => moveCursor(key.downArrow || input === 'j' ? 1 : -1),
      },
      { keys: ['↵'], hint: 'edit', enabled: focused !== undefined, run: handleEdit },
      { keys: ['e'], hint: 'edit field', hidden: true, enabled: focused !== undefined, run: handleEdit },
      // Surface the `m` chord only while the viewed project is not already current — once they
      // match the action is a no-op and the hint adds noise (mirrors sprint-detail).
      {
        keys: ['m'],
        hint: 'current',
        enabled: project !== undefined && selection.projectId !== project.id,
        run: () => {
          if (project !== undefined) markCurrent(project);
        },
      },
      {
        keys: ['a'],
        hint: 'add repo',
        enabled: project !== undefined,
        run: () => {
          if (project !== undefined) router.push({ id: 'add-repository', props: { projectId: project.id } });
        },
      },
      // Repo-scoped chords act on the focused row only when it is a repo.
      {
        keys: ['d'],
        hint: 'remove repo',
        enabled: focusedRepo !== undefined,
        run: () => {
          if (focusedRepo !== undefined) args.setConfirmRemove(focusedRepo);
        },
      },
      {
        keys: ['c'],
        hint: 'detect scripts',
        enabled: focusedRepo !== undefined,
        run: () => {
          if (focusedRepo !== undefined) void launchPerRepoFlow(args, project, 'detect-scripts', focusedRepo);
        },
      },
      {
        keys: ['S'],
        hint: 'detect skills',
        enabled: focusedRepo !== undefined,
        run: () => {
          if (focusedRepo !== undefined) void launchPerRepoFlow(args, project, 'detect-skills', focusedRepo);
        },
      },
    ],
    { active: !ui.modalOpen && args.confirmRemove === undefined && project !== undefined }
  );
};

/**
 * Flat field cursor — every editable row gets one stable index. Top-to-bottom order matches
 * the rendered card layout: project displayName first, then each repo's name / setup / verify
 * in turn. The cursor advances through the same array the renderer walks. Takes `project`
 * itself (not a derived array) so callers don't have to worry about a fresh reference per render.
 */
const useProjectFields = (project: Project | undefined): readonly Field[] =>
  useMemo<readonly Field[]>(() => {
    if (project === undefined) return [];
    return [
      { kind: 'project', field: 'displayName' },
      ...project.repositories.flatMap((r): readonly Field[] => [
        { kind: 'repo', field: 'name', repo: r },
        { kind: 'repo', field: 'setupScript', repo: r },
        { kind: 'repo', field: 'verifyScript', repo: r },
      ]),
    ];
  }, [project]);

interface RemoveRepoConfirmedArgs {
  readonly project: Project | undefined;
  readonly projectRepo: ReturnType<typeof useDeps>['projectRepo'];
  readonly mountedRef: ReturnType<typeof useIsMounted>;
  readonly setFeedback: (message: string | undefined) => void;
  readonly setConfirmRemove: (repo: Repository | undefined) => void;
  readonly reload: () => void;
}

/** `ConfirmCard`'s Yes/No answer for the pending repo removal. Dismisses the overlay
 *  unconditionally, then — only on a Yes with a project still loaded — persists the removal. */
const handleRemoveConfirmed = async (
  args: RemoveRepoConfirmedArgs,
  target: Repository,
  confirmed: boolean
): Promise<void> => {
  args.setConfirmRemove(undefined);
  if (!confirmed || args.project === undefined) return;
  const removeResult = await removeRepoFromProject(args.project, target.id, args.projectRepo);
  if (!removeResult.ok) {
    if (args.mountedRef.current) args.setFeedback(`✗ ${removeResult.error}`);
    return;
  }
  if (!args.mountedRef.current) return;
  args.setFeedback(`✓ removed ${target.name}`);
  args.reload();
};

interface DetailContentProps {
  readonly state: AsyncLoadState<Project, unknown>;
  readonly confirmRemove: Repository | undefined;
  readonly onRemoveSubmit: (repo: Repository, value: boolean) => void;
  readonly onRemoveCancel: () => void;
  readonly focused: Field | undefined;
  readonly feedback: string | undefined;
}

/** The view's single content slot — load states, the remove-repo confirm, or the
 *  loaded project body, in that priority order. Pulled out of the orchestrator so the component
 *  itself only wires state and handlers. */
const DetailContent = ({
  state,
  confirmRemove,
  onRemoveSubmit,
  onRemoveCancel,
  focused,
  feedback,
}: DetailContentProps): React.JSX.Element => {
  if (state.kind === 'loading' || state.kind === 'idle') return <LoadingRow label="Loading…" />;
  if (state.kind === 'error') return <LoadErrorRow message="Failed to load project." />;
  if (confirmRemove !== undefined) {
    return (
      <ConfirmCard
        title={
          <Text>
            Remove repository <Text bold>{confirmRemove.name}</Text> from this project?
          </Text>
        }
        body={<Text dimColor>Files on disk are not touched.</Text>}
        message="Remove?"
        onSubmit={(value) => onRemoveSubmit(confirmRemove, value)}
        onCancel={onRemoveCancel}
      />
    );
  }
  return <Body project={state.value} focused={focused} feedback={feedback} />;
};

export const ProjectDetailView = (): React.JSX.Element => {
  const deps = useDeps();
  const router = useRouter();
  const ui = useUiState();
  const { projectId } = useViewProps<ProjectDetailProps>();
  const sessions = useSessionManager();
  const queue = usePromptQueue();
  const storage = useStorage();
  const edit = useEditField();

  const { state, reload } = useAsyncLoad<Project>(async () => {
    const r = await deps.projectRepo.findById(projectId);
    if (!r.ok) throw new Error(r.error.message);
    return r.value;
  }, [projectId]);

  const selection = useSelection();
  useSyncCurrentProjectLabel(state, selection);

  const [cursorIdx, setCursorIdx] = useState(0);
  const [confirmRemove, setConfirmRemove] = useState<Repository | undefined>(undefined);
  const [feedback, setFeedback] = useState<string | undefined>(undefined);

  // Mounted-ref guard for the async remove-repo handler: dismissing the confirm overlay unblocks the
  // router, so the operator can navigate away (unmounting this view) before the awaited save resolves.
  // The guard skips the post-await view-local writes (setFeedback / reload) so they never fire into an
  // unmounted tree.
  const mountedRef = useIsMounted();

  const project = state.kind === 'ok' ? state.value : undefined;

  const fields = useProjectFields(project);
  const focused = fields[Math.min(cursorIdx, Math.max(0, fields.length - 1))];

  // Reset the cursor when the underlying project changes — both the first successful load
  // (loading → ok) and a re-route to a different projectId. Without this, switching from a
  // project with 4 fields to one with 1 would leave the cursor pinned at index 3 (clamped) and
  // visually parked on the only available row, but a subsequent reload back to the larger
  // project would resume mid-list — surprising.
  useEffect(() => {
    if (state.kind === 'ok') setCursorIdx(0);
  }, [state.kind, projectId]);

  useProjectDetailShortcuts({
    deps,
    router,
    ui,
    queue,
    storage,
    sessions,
    selection,
    edit,
    project,
    focused,
    fieldsLength: fields.length,
    confirmRemove,
    setCursorIdx,
    setConfirmRemove,
    setFeedback,
    mountedRef,
    reload,
  });

  const removeCtx: RemoveRepoConfirmedArgs = {
    project,
    projectRepo: deps.projectRepo,
    mountedRef,
    setFeedback,
    setConfirmRemove,
    reload,
  };

  return (
    <ViewShell
      title="Project"
      subtitle={state.kind === 'ok' ? state.value.displayName : 'loading'}
      suppressScrollArrows
    >
      <DetailContent
        state={state}
        confirmRemove={confirmRemove}
        onRemoveSubmit={(repo, value) => void handleRemoveConfirmed(removeCtx, repo, value)}
        onRemoveCancel={() => setConfirmRemove(undefined)}
        focused={focused}
        feedback={feedback ?? edit.feedback}
      />
    </ViewShell>
  );
};

const removeRepoFromProject = async (
  project: Project,
  repoId: RepositoryId,
  projectRepo: ReturnType<typeof useDeps>['projectRepo']
): Promise<{ ok: true } | { ok: false; error: string }> => {
  const updated = removeRepository(project, repoId);
  if (!updated.ok) return { ok: false, error: updated.error.message };
  const saved = await projectRepo.save(updated.value);
  if (!saved.ok) return { ok: false, error: saved.error.message };
  return { ok: true };
};
