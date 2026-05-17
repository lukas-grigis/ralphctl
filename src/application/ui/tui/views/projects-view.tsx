/**
 * Projects list — read-only enumeration of every project in storage. Selecting a row pushes
 * the project detail view and stamps the selection cursor on the row's id, so subsequent
 * sprint-related navigation stays scoped to the right project.
 */

import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { ViewShell } from '@src/application/ui/tui/components/view-shell.tsx';
import { CardList } from '@src/application/ui/tui/components/card-list.tsx';
import { EmptyState } from '@src/application/ui/tui/components/empty-state.tsx';
import { Spinner } from '@src/application/ui/tui/components/spinner.tsx';
import { ConfirmPrompt } from '@src/application/ui/tui/prompts/confirm-prompt.tsx';
import type { Project } from '@src/domain/entity/project.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import { spacing, glyphs, inkColors } from '@src/application/ui/tui/theme/tokens.ts';
import { useDeps } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { useAsyncLoad } from '@src/application/ui/tui/runtime/use-async-load.ts';
import { useRouter } from '@src/application/ui/tui/runtime/router.tsx';
import { useSelection } from '@src/application/ui/tui/runtime/selection-context.tsx';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { useViewHints } from '@src/application/ui/tui/runtime/use-view-hints.tsx';
import { HelpOverlay } from '@src/application/ui/tui/components/help-overlay.tsx';

export const ProjectsView = (): React.JSX.Element => {
  const deps = useDeps();
  const router = useRouter();
  const selection = useSelection();
  const ui = useUiState();
  useViewHints([
    { keys: '↵', label: 'open' },
    { keys: 'c', label: 'create' },
    { keys: 'd', label: 'delete' },
    { keys: 'r', label: 'reload' },
  ]);

  const [cursorId, setCursorId] = useState<ProjectId | undefined>(undefined);
  const [confirmDelete, setConfirmDelete] = useState<Project | undefined>(undefined);
  const [feedback, setFeedback] = useState<string | undefined>(undefined);

  const { state, reload } = useAsyncLoad<readonly Project[]>(async () => {
    const r = await deps.projectRepo.list();
    if (!r.ok) throw new Error(r.error.message);
    return r.value;
  }, []);

  const items = state.kind === 'ok' ? state.value : [];

  useInput((input) => {
    if (ui.helpOpen || ui.promptActive || confirmDelete !== undefined) return;
    if (input === 'c') {
      router.push({ id: 'create-project' });
      return;
    }
    if (input === 'd') {
      const target = items.find((p) => p.id === cursorId) ?? items[0];
      if (target !== undefined) setConfirmDelete(target);
      return;
    }
    if (input === 'r') {
      setFeedback('↻ reloading…');
      reload();
    }
  });

  // Claim the global-key mute while the confirm prompt is mounted.
  useEffect(() => (confirmDelete !== undefined ? ui.claimPrompt() : undefined), [confirmDelete, ui.claimPrompt]);

  const handleDeleteConfirmed = async (target: Project, confirmed: boolean): Promise<void> => {
    setConfirmDelete(undefined);
    if (!confirmed) return;
    const r = await deps.projectRepo.remove(target.id);
    if (!r.ok) {
      setFeedback(`✗ ${r.error.message}`);
      return;
    }
    if (selection.projectId === target.id) selection.setProject(undefined);
    setFeedback(`✓ removed ${target.displayName}`);
    reload();
  };

  return (
    <ViewShell title="Projects" subtitle="Pick a project to make it the current selection">
      {ui.helpOpen ? (
        <HelpOverlay />
      ) : state.kind === 'loading' || state.kind === 'idle' ? (
        <Box paddingX={spacing.indent}>
          <Spinner label="Loading projects…" />
        </Box>
      ) : state.kind === 'error' ? (
        <Box paddingX={spacing.indent}>
          <Text>Failed to load projects.</Text>
        </Box>
      ) : confirmDelete !== undefined ? (
        <Box flexDirection="column" paddingX={spacing.indent}>
          <Text>
            Remove project <Text bold>{confirmDelete.displayName}</Text>?
          </Text>
          <Text dimColor>Sprints and repository contents are not touched.</Text>
          <Box marginTop={1}>
            <ConfirmPrompt
              message="Delete?"
              defaultYes={false}
              onSubmit={(value) => void handleDeleteConfirmed(confirmDelete, value)}
              onCancel={() => setConfirmDelete(undefined)}
            />
          </Box>
        </Box>
      ) : state.value.length === 0 ? (
        <EmptyState
          title="No projects yet"
          hint="Press c to create the first one."
          action={`c ${glyphs.arrowRight} create  ${glyphs.bullet}  esc ${glyphs.arrowRight} back`}
        />
      ) : (
        <Box flexDirection="column">
          <CardList
            items={state.value}
            visibleRows={4}
            active={!ui.promptActive && confirmDelete === undefined}
            onSelect={(p): void => {
              selection.setProject(p.id, p.displayName);
              router.push({ id: 'project-detail', props: { projectId: p.id } });
            }}
            onCursor={(p): void => setCursorId(p.id)}
            renderCard={(p, focused) => (
              <Box flexDirection="column">
                <Box justifyContent="space-between">
                  <Text bold {...(focused ? { color: inkColors.primary } : {})}>
                    {p.displayName}
                  </Text>
                  <Text dimColor>
                    {String(p.repositories.length)} repo{p.repositories.length === 1 ? '' : 's'}
                  </Text>
                </Box>
                <Text dimColor>
                  {p.slug}
                  {p.description !== undefined && p.description.length > 0 ? ` ${glyphs.bullet} ${p.description}` : ''}
                </Text>
                {p.repositories.slice(0, 2).map((r) => (
                  <Text key={r.id} dimColor>
                    {glyphs.activityArrow} {r.name} <Text dimColor>{r.path}</Text>
                  </Text>
                ))}
                {p.repositories.length > 2 && (
                  <Text dimColor italic>
                    +{String(p.repositories.length - 2)} more repository{p.repositories.length - 2 === 1 ? '' : 'ies'}
                  </Text>
                )}
              </Box>
            )}
          />
          <Box paddingX={spacing.indent} marginTop={spacing.section}>
            <Text dimColor>
              {glyphs.bullet} {state.value.length} project(s) {glyphs.bullet} ↵ open {glyphs.bullet} c create{' '}
              {glyphs.bullet} d delete {glyphs.bullet} r reload
            </Text>
          </Box>
          {feedback !== undefined && (
            <Box paddingX={spacing.indent} marginTop={1}>
              <Text color={feedback.startsWith('✗') ? inkColors.error : inkColors.primary}>{feedback}</Text>
            </Box>
          )}
        </Box>
      )}
    </ViewShell>
  );
};
