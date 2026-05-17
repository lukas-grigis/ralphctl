/**
 * Sprint picker — mirror of {@link PickProjectView} scoped to the active project. Lets the
 * user pivot the session's "current sprint" in one keystroke from anywhere that lands here
 * (home view's `S` quick action; global `S` chord). Enter persists the choice via
 * `selection.setSprint` and resets the router to home so the menu's gating + state card
 * reflect the new sprint immediately.
 *
 * `+` launches the create-sprint chain flow via the same launcher dance used by SprintsView —
 * keeps a single "create a sprint" surface so the prompt + session-bridge wiring stays in one
 * place.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { ViewShell } from '@src/application/ui/tui/components/view-shell.tsx';
import { Spinner } from '@src/application/ui/tui/components/spinner.tsx';
import { Card } from '@src/application/ui/tui/components/card.tsx';
import { StatusChip, sprintStatusKind } from '@src/application/ui/tui/components/status-chip.tsx';
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
import { launchFlow, sessionHintsFromLaunchResult } from '@src/application/ui/shared/launcher.ts';
import { loadAppStateSnapshot } from '@src/application/ui/shared/state-snapshot.ts';
import { HelpOverlay } from '@src/application/ui/tui/components/help-overlay.tsx';
import type { Sprint } from '@src/domain/entity/sprint.ts';

export const PickSprintView = (): React.JSX.Element => {
  const deps = useDeps();
  const router = useRouter();
  const selection = useSelection();
  const ui = useUiState();
  const sessions = useSessionManager();
  const queue = usePromptQueue();
  const storage = useStorage();
  const [feedback, setFeedback] = useState<string | undefined>(undefined);
  useViewHints([
    { keys: '↵', label: 'use sprint' },
    { keys: '+', label: 'create new' },
    { keys: 'r', label: 'reload' },
  ]);

  const { state, reload } = useAsyncLoad<readonly Sprint[]>(async () => {
    const r = await deps.sprintRepo.list();
    if (!r.ok) throw new Error(r.error.message);
    return selection.projectId !== undefined ? r.value.filter((s) => s.projectId === selection.projectId) : [];
  }, [selection.projectId]);

  const sprints = state.kind === 'ok' ? state.value : [];

  // Pre-seed the cursor to the already-selected sprint so Enter is a one-keystroke confirm.
  const initialIdx = useMemo(() => {
    if (selection.sprintId === undefined) return 0;
    const i = sprints.findIndex((s) => s.id === selection.sprintId);
    return i === -1 ? 0 : i;
  }, [sprints, selection.sprintId]);

  const [cursor, setCursor] = useState<number>(initialIdx);
  useEffect(() => {
    setCursor((c) => (c >= sprints.length ? Math.max(0, sprints.length - 1) : c));
  }, [sprints.length]);
  useEffect(() => {
    setCursor(initialIdx);
  }, [initialIdx]);

  const pick = (sprint: Sprint): void => {
    selection.setSprint(sprint.id, sprint.name);
    router.reset({ id: 'home' });
  };

  // Same launcher dance as sprints-view.tsx — keeps create-sprint's prompt + session wiring
  // in a single place. Failures surface inline; success pushes the execute view.
  const launchCreateSprint = async (): Promise<void> => {
    if (selection.projectId === undefined) {
      setFeedback('✗ no project loaded');
      return;
    }
    const snapshot = await loadAppStateSnapshot(
      { projectRepo: deps.projectRepo, sprintRepo: deps.sprintRepo, taskRepo: deps.taskRepo },
      { projectId: selection.projectId }
    );
    const interactive = createInkInteractivePrompt(queue);
    const result = await launchFlow(
      { app: deps, interactive, storage, runInTerminal: getRunInTerminal() },
      'create-sprint',
      snapshot
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

  useInput((input, key) => {
    if (ui.helpOpen || ui.promptActive) return;
    if (key.upArrow || input === 'k') {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.downArrow || input === 'j') {
      setCursor((c) => Math.min(sprints.length - 1, c + 1));
      return;
    }
    if (key.return) {
      const target = sprints[cursor];
      if (target !== undefined) pick(target);
      return;
    }
    if (input === '+' || input === 'c') {
      void launchCreateSprint();
      return;
    }
    if (input === 'r') reload();
  });

  return (
    <ViewShell title="Pick a sprint" subtitle="Picks the sprint for the rest of the session">
      {ui.helpOpen ? (
        <HelpOverlay />
      ) : selection.projectId === undefined ? (
        <Card title="▸ No project loaded" tone="primary">
          <Box flexDirection="column" paddingX={spacing.indent}>
            <Text>Pick a project first — press P to open the project picker.</Text>
          </Box>
        </Card>
      ) : state.kind === 'loading' || state.kind === 'idle' ? (
        <Box paddingX={spacing.indent}>
          <Spinner label="Loading sprints…" />
        </Box>
      ) : state.kind === 'error' ? (
        <Box paddingX={spacing.indent}>
          <Text color={inkColors.error}>Failed to load sprints.</Text>
        </Box>
      ) : sprints.length === 0 ? (
        <Card title="▸ No sprints in this project yet" tone="primary">
          <Box flexDirection="column" paddingX={spacing.indent}>
            <Text>Sprints are the unit of work. Press + to create one.</Text>
          </Box>
        </Card>
      ) : (
        <Box flexDirection="column">
          <Box paddingX={spacing.indent} marginBottom={spacing.section}>
            <Text dimColor>
              {String(sprints.length)} sprint{sprints.length === 1 ? '' : 's'} {glyphs.bullet}{' '}
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
          <Box flexDirection="column">
            {sprints.map((s, i) => {
              const focused = i === cursor;
              const isCurrent = selection.sprintId === s.id;
              return (
                <Box key={s.id} flexDirection="column" paddingX={spacing.indent}>
                  <Box>
                    <Text color={focused ? inkColors.primary : inkColors.rule}>{focused ? '▍' : ' '}</Text>
                    <Text>
                      {' '}
                      <Text color={focused ? inkColors.primary : inkColors.muted} bold={focused}>
                        {s.name}
                      </Text>{' '}
                      <StatusChip label={s.status} kind={sprintStatusKind(s.status)} />
                      {isCurrent && (
                        <Text dimColor italic>
                          {' '}
                          {glyphs.bullet} current
                        </Text>
                      )}
                    </Text>
                  </Box>
                  {focused && (
                    <Box paddingLeft={3}>
                      <Text dimColor>
                        {glyphs.activityArrow} {String(s.tickets.length)} ticket
                        {s.tickets.length === 1 ? '' : 's'}
                      </Text>
                    </Box>
                  )}
                </Box>
              );
            })}
          </Box>
          <Box marginTop={spacing.section} paddingX={spacing.indent}>
            <Text dimColor>
              {glyphs.bullet} ↵ use the highlighted sprint {glyphs.bullet} + create a new one
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
