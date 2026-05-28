/**
 * Project detail — info card + repository roster + per-repo health (paths + scripts). Pressing
 * `r` jumps to this project's sprints; `n` opens the flow launcher with this project current.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { ViewShell } from '@src/application/ui/tui/components/view-shell.tsx';
import { Card } from '@src/application/ui/tui/components/card.tsx';
import { FieldList } from '@src/application/ui/tui/components/field-list.tsx';
import { Spinner } from '@src/application/ui/tui/components/spinner.tsx';
import { ConfirmPrompt } from '@src/application/ui/tui/prompts/confirm-prompt.tsx';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { removeRepository, setProjectDisplayName, type Project, updateRepository } from '@src/domain/entity/project.ts';
import { setRepositorySetupScript, setRepositoryVerifyScript } from '@src/domain/entity/repository.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { Repository } from '@src/domain/entity/repository.ts';
import type { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import { Result } from '@src/domain/result.ts';
import { useEditField, type OpenEditPromptInput } from '@src/application/ui/tui/runtime/use-edit-field.ts';
import { useDeps } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { useAsyncLoad } from '@src/application/ui/tui/runtime/use-async-load.ts';
import { useRouter, useViewProps } from '@src/application/ui/tui/runtime/router.tsx';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { useSelection } from '@src/application/ui/tui/runtime/selection-context.tsx';
import { useViewHints } from '@src/application/ui/tui/runtime/use-view-hints.tsx';
import { useSessionManager } from '@src/application/ui/tui/runtime/sessions-context.tsx';
import { usePromptQueue } from '@src/application/ui/tui/prompts/prompt-context.tsx';
import { createInkInteractivePrompt } from '@src/application/ui/tui/prompts/ink-interactive-prompt.ts';
import { useStorage } from '@src/application/ui/tui/runtime/storage-context.tsx';
import { getRunInTerminal } from '@src/application/ui/tui/runtime/run-in-terminal.ts';
import { launchFlow, sessionHintsFromLaunchResult } from '@src/application/ui/shared/launcher.ts';
import { loadAppStateSnapshot } from '@src/application/ui/shared/state-snapshot.ts';
import { HelpOverlay } from '@src/application/ui/tui/components/help-overlay.tsx';

interface ProjectDetailProps extends Readonly<Record<string, unknown>> {
  readonly projectId: ProjectId;
}

type RepoFieldKey = 'name' | 'setupScript' | 'verifyScript';
type Field =
  | { readonly kind: 'project'; readonly field: 'displayName' }
  | { readonly kind: 'repo'; readonly field: RepoFieldKey; readonly repo: Repository };

type EditTarget =
  | { readonly kind: 'project' }
  | { readonly kind: 'repo'; readonly field: RepoFieldKey; readonly repo: Repository };

export const ProjectDetailView = (): React.JSX.Element => {
  const deps = useDeps();
  const router = useRouter();
  const ui = useUiState();
  const { projectId } = useViewProps<ProjectDetailProps>();
  useViewHints([
    { keys: 'r', label: 'sprints' },
    { keys: 'a', label: 'add repo' },
    { keys: 'd', label: 'remove repo' },
    { keys: 'c', label: 'detect scripts' },
    { keys: 'S', label: 'detect skills' },
  ]);
  const sessions = useSessionManager();
  const queue = usePromptQueue();
  const storage = useStorage();
  const edit = useEditField();

  const { state, reload } = useAsyncLoad<Project>(async () => {
    const r = await deps.projectRepo.findById(projectId);
    if (!r.ok) throw new Error(r.error.message);
    return r.value;
  }, [projectId]);

  // Once the project loads, stamp its display name into the selection cache so the status bar
  // can show "proj: <name>" without re-loading the aggregate. Direct routes (deep links from
  // suggestions) may not have stamped a label yet.
  const selection = useSelection();
  const setProjectRef = React.useRef(selection.setProject);
  setProjectRef.current = selection.setProject;
  React.useEffect(() => {
    if (state.kind === 'ok') setProjectRef.current(state.value.id, state.value.displayName);
  }, [state]);

  const [cursorIdx, setCursorIdx] = useState(0);
  const [confirmRemove, setConfirmRemove] = useState<Repository | undefined>(undefined);
  const [feedback, setFeedback] = useState<string | undefined>(undefined);

  const project = state.kind === 'ok' ? state.value : undefined;

  // Flat field cursor — every editable row gets one stable index. Top-to-bottom order matches
  // the rendered card layout: project displayName first, then each repo's name / setup / verify
  // in turn. The cursor advances through the same array the renderer walks. `repos` is derived
  // from `project` so we close over the project itself, not the derived array (the linter would
  // flag the derived value as a fresh reference per render).
  const fields = useMemo<readonly Field[]>(() => {
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

  const focused = fields[Math.min(cursorIdx, Math.max(0, fields.length - 1))];

  // Reset the cursor when the underlying project changes — both the first successful load
  // (loading → ok) and a re-route to a different projectId. Without this, switching from a
  // project with 4 fields to one with 1 would leave the cursor pinned at index 3 (clamped) and
  // visually parked on the only available row, but a subsequent reload back to the larger
  // project would resume mid-list — surprising.
  useEffect(() => {
    if (state.kind === 'ok') setCursorIdx(0);
  }, [state.kind, projectId]);

  const launchPerRepoFlow = async (flowId: 'detect-scripts' | 'detect-skills', target: Repository): Promise<void> => {
    if (project === undefined) return;
    setFeedback(undefined);
    const snapshot = await loadAppStateSnapshot(
      { projectRepo: deps.projectRepo, sprintRepo: deps.sprintRepo, taskRepo: deps.taskRepo },
      { projectId: project.id }
    );
    const interactive = createInkInteractivePrompt(queue);
    const result = await launchFlow(
      { app: deps, interactive, storage, runInTerminal: getRunInTerminal() },
      flowId,
      snapshot,
      { repositoryId: target.id }
    );
    if (!result.ok) {
      setFeedback(`✗ ${result.reason}`);
      return;
    }
    sessions.register({
      runner: result.runner,
      flowId,
      title: result.title,
      ...sessionHintsFromLaunchResult(result),
    });
    void result.runner.start();
    router.push({ id: 'execute', props: { sessionId: result.runner.id } });
  };

  const renderEditPrompt = (target: EditTarget): OpenEditPromptInput | undefined => {
    if (project === undefined) return undefined;
    if (target.kind === 'project') {
      return {
        title: `Rename project "${project.displayName}"`,
        kind: 'short',
        currentValue: project.displayName,
        onSave: async (value) => {
          const renamed = setProjectDisplayName(project, value);
          if (!renamed.ok) return Result.error(renamed.error);
          const saved = await deps.projectRepo.save(renamed.value);
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
          const saved = await deps.projectRepo.save(next.value);
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
        const saved = await deps.projectRepo.save({ ...project, repositories: nextRepos });
        if (!saved.ok) return Result.error(saved.error);
        reload();
        return Result.ok(undefined);
      },
      successLabel: `✓ updated ${field}`,
    };
  };

  const handleEdit = (): void => {
    if (project === undefined || focused === undefined) return;
    setFeedback(undefined);
    const target: EditTarget =
      focused.kind === 'project' ? { kind: 'project' } : { kind: 'repo', field: focused.field, repo: focused.repo };
    const cfg = renderEditPrompt(target);
    if (cfg !== undefined) void edit.openEditPrompt(cfg);
  };

  useInput((input, key) => {
    if (ui.helpOpen || ui.promptActive || confirmRemove !== undefined || project === undefined) return;
    if (input === 'a') {
      router.push({ id: 'add-repository', props: { projectId: project.id } });
      return;
    }
    if (input === 'e' || key.return) {
      handleEdit();
      return;
    }
    if (key.downArrow || input === 'j') {
      setCursorIdx((c) => Math.min(Math.max(0, fields.length - 1), c + 1));
      return;
    }
    if (key.upArrow || input === 'k') {
      setCursorIdx((c) => Math.max(0, c - 1));
      return;
    }
    if (input === 'd' && focused?.kind === 'repo') {
      setConfirmRemove(focused.repo);
      return;
    }
    if (input === 'c' && focused?.kind === 'repo') {
      void launchPerRepoFlow('detect-scripts', focused.repo);
      return;
    }
    if (input === 'S' && focused?.kind === 'repo') {
      void launchPerRepoFlow('detect-skills', focused.repo);
    }
  });

  // Claim the global-key mute while the confirm prompt is mounted.
  const claimPrompt = ui.claimPrompt;
  useEffect(() => (confirmRemove !== undefined ? claimPrompt() : undefined), [confirmRemove, claimPrompt]);

  const handleRemoveConfirmed = async (target: Repository, confirmed: boolean): Promise<void> => {
    setConfirmRemove(undefined);
    if (!confirmed || project === undefined) return;
    const removeResult = await removeRepoFromProject(project, target.id, deps.projectRepo);
    if (!removeResult.ok) {
      setFeedback(`✗ ${removeResult.error}`);
      return;
    }
    setFeedback(`✓ removed ${target.name}`);
    reload();
  };

  return (
    <ViewShell title="Project" subtitle={state.kind === 'ok' ? state.value.displayName : 'loading'}>
      {ui.helpOpen ? (
        <HelpOverlay />
      ) : state.kind === 'loading' || state.kind === 'idle' ? (
        <Box paddingX={spacing.indent}>
          <Spinner label="Loading…" />
        </Box>
      ) : state.kind === 'error' ? (
        <Box paddingX={spacing.indent}>
          <Text>Failed to load project.</Text>
        </Box>
      ) : confirmRemove !== undefined ? (
        <Box flexDirection="column" paddingX={spacing.indent}>
          <Text>
            Remove repository <Text bold>{confirmRemove.name}</Text> from this project?
          </Text>
          <Text dimColor>Files on disk are not touched.</Text>
          <Box marginTop={1}>
            <ConfirmPrompt
              message="Remove?"
              defaultYes={false}
              onSubmit={(value) => void handleRemoveConfirmed(confirmRemove, value)}
              onCancel={() => setConfirmRemove(undefined)}
            />
          </Box>
        </Box>
      ) : (
        <Body project={state.value} focused={focused} feedback={feedback ?? edit.feedback} />
      )}
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

interface BodyProps {
  readonly project: Project;
  readonly focused: Field | undefined;
  readonly feedback: string | undefined;
}

/** Wrap a field value with the action-cursor glyph + primary color when focused. Mirrors the
 *  pattern from settings-view.tsx so the focus signal stays consistent across detail views. */
const focusable = (focused: boolean, node: React.ReactNode): React.ReactNode => (
  <Text {...(focused ? { color: inkColors.primary } : {})} bold={focused}>
    {focused ? `${glyphs.actionCursor} ` : '  '}
    {node}
  </Text>
);

const noneText = (
  <Text dimColor italic>
    (none)
  </Text>
);

interface RepoCardProps {
  readonly repo: Repository;
  readonly focused: Field | undefined;
}

const RepoCard = ({ repo, focused }: RepoCardProps): React.JSX.Element => {
  const repoFocused = focused?.kind === 'repo' && focused.repo.id === repo.id;
  const nameFocused = repoFocused && focused.field === 'name';
  const setupFocused = repoFocused && focused.field === 'setupScript';
  const verifyFocused = repoFocused && focused.field === 'verifyScript';
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={inkColors.rule}
      paddingX={spacing.cardPadX}
      marginTop={1}
    >
      <Text bold {...(nameFocused ? { color: inkColors.primary } : {})}>
        {nameFocused ? `${glyphs.actionCursor} ` : '  '}
        {repo.name} <Text dimColor>({repo.slug})</Text>
      </Text>
      <FieldList
        fields={[
          { label: 'Path', value: <Text dimColor>{repo.path}</Text> },
          { label: 'Setup', value: focusable(setupFocused, repo.setupScript ?? noneText) },
          { label: 'Verify', value: focusable(verifyFocused, repo.verifyScript ?? noneText) },
        ]}
      />
    </Box>
  );
};

const Body = ({ project, focused, feedback }: BodyProps): React.JSX.Element => {
  const projectNameFocused = focused?.kind === 'project';
  return (
    <Box flexDirection="column">
      <Card title="Project" tone="primary">
        <FieldList
          fields={[
            {
              label: 'Name',
              value: focusable(projectNameFocused, <Text bold>{project.displayName}</Text>),
            },
            { label: 'Slug', value: project.slug },
            { label: 'Id', value: <Text dimColor>{project.id}</Text> },
            ...(project.description !== undefined ? [{ label: 'Description', value: project.description }] : []),
            { label: 'Repositories', value: String(project.repositories.length) },
          ]}
        />
      </Card>
      <Box marginTop={spacing.section} flexDirection="column">
        <Text bold>{glyphs.badge} Repositories</Text>
        {project.repositories.map((repo) => (
          <RepoCard key={repo.id} repo={repo} focused={focused} />
        ))}
        <Box paddingX={spacing.indent} marginTop={spacing.section}>
          <Text dimColor>
            a add {glyphs.bullet} ↑/↓ navigate {glyphs.bullet} e/↵ edit field {glyphs.bullet} c detect scripts{' '}
            {glyphs.bullet} S detect skills {glyphs.bullet} d remove (keeps ≥ 1)
          </Text>
        </Box>
        {feedback !== undefined && (
          <Box paddingX={spacing.indent} marginTop={1}>
            <Text color={feedback.startsWith('✗') ? inkColors.error : inkColors.primary}>{feedback}</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
};
