/**
 * Project detail — info card + repository roster + per-repo health (paths + scripts). Pressing
 * `r` jumps to this project's sprints; `n` opens the flow launcher with this project current.
 */

import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { ViewShell } from '@src/application/ui/tui/components/view-shell.tsx';
import { Card } from '@src/application/ui/tui/components/card.tsx';
import { FieldList } from '@src/application/ui/tui/components/field-list.tsx';
import { Spinner } from '@src/application/ui/tui/components/spinner.tsx';
import { ConfirmPrompt } from '@src/application/ui/tui/prompts/confirm-prompt.tsx';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { removeRepository, type Project } from '@src/domain/entity/project.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { Repository } from '@src/domain/entity/repository.ts';
import type { RepositoryId } from '@src/domain/value/id/repository-id.ts';
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
  const repos = project?.repositories ?? [];

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

  useInput((input, key) => {
    if (ui.helpOpen || ui.promptActive || confirmRemove !== undefined || project === undefined) return;
    if (input === 'a') {
      router.push({ id: 'add-repository', props: { projectId: project.id } });
      return;
    }
    if ((key.downArrow || input === 'j') && repos.length > 0) {
      setCursorIdx((c) => Math.min(repos.length - 1, c + 1));
      return;
    }
    if ((key.upArrow || input === 'k') && repos.length > 0) {
      setCursorIdx((c) => Math.max(0, c - 1));
      return;
    }
    if (input === 'd' && repos.length > 0) {
      const target = repos[Math.min(cursorIdx, repos.length - 1)];
      if (target !== undefined) setConfirmRemove(target);
      return;
    }
    if (input === 'c' && repos.length > 0) {
      const target = repos[Math.min(cursorIdx, repos.length - 1)];
      if (target !== undefined) void launchPerRepoFlow('detect-scripts', target);
      return;
    }
    if (input === 'S' && repos.length > 0) {
      const target = repos[Math.min(cursorIdx, repos.length - 1)];
      if (target !== undefined) void launchPerRepoFlow('detect-skills', target);
    }
  });

  // Claim the global-key mute while the confirm prompt is mounted.
  useEffect(() => (confirmRemove !== undefined ? ui.claimPrompt() : undefined), [confirmRemove, ui.claimPrompt]);

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
        <Body
          project={state.value}
          cursorIdx={Math.min(cursorIdx, Math.max(0, repos.length - 1))}
          feedback={feedback}
        />
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
  readonly cursorIdx: number;
  readonly feedback: string | undefined;
}

const Body = ({ project, cursorIdx, feedback }: BodyProps): React.JSX.Element => (
  <Box flexDirection="column">
    <Card title="Project" tone="primary">
      <FieldList
        fields={[
          { label: 'Name', value: <Text bold>{project.displayName}</Text> },
          { label: 'Slug', value: project.slug },
          { label: 'Id', value: <Text dimColor>{project.id}</Text> },
          ...(project.description !== undefined ? [{ label: 'Description', value: project.description }] : []),
          { label: 'Repositories', value: String(project.repositories.length) },
        ]}
      />
    </Card>
    <Box marginTop={spacing.section} flexDirection="column">
      <Text bold>{glyphs.badge} Repositories</Text>
      {project.repositories.map((repo, idx) => {
        const focused = idx === cursorIdx;
        return (
          <Box
            key={repo.id}
            flexDirection="column"
            borderStyle="round"
            borderColor={focused ? inkColors.primary : inkColors.rule}
            borderDimColor={!focused}
            paddingX={spacing.cardPadX}
            marginTop={1}
          >
            <Text bold {...(focused ? { color: inkColors.primary } : {})}>
              {focused ? `${glyphs.actionCursor} ` : '  '}
              {repo.name} <Text dimColor>({repo.slug})</Text>
            </Text>
            <FieldList
              fields={[
                { label: 'Path', value: <Text dimColor>{repo.path}</Text> },
                {
                  label: 'Setup',
                  value: repo.setupScript ?? (
                    <Text dimColor italic>
                      (none)
                    </Text>
                  ),
                },
                {
                  label: 'Verify',
                  value: repo.verifyScript ?? (
                    <Text dimColor italic>
                      (none)
                    </Text>
                  ),
                },
              ]}
            />
          </Box>
        );
      })}
      <Box paddingX={spacing.indent} marginTop={spacing.section}>
        <Text dimColor>
          {glyphs.bullet} a add {glyphs.bullet} ↑/↓ select {glyphs.bullet} c detect scripts {glyphs.bullet} S detect
          skills {glyphs.bullet} d remove (keeps ≥ 1)
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
