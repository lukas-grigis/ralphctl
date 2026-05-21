/**
 * Sprints list — every sprint, scoped to the current project when one is selected. Selecting
 * a row sets it as the current sprint and pushes its detail view.
 *
 * Local keys:
 *   c   launch the create-sprint flow against the current project.
 *   d   confirm + remove the focused sprint (cascades execution + tasks via sprintRepo.remove).
 *   ↵   open the sprint's detail view.
 */

import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { ViewShell } from '@src/application/ui/tui/components/view-shell.tsx';
import { CardList } from '@src/application/ui/tui/components/card-list.tsx';
import { EmptyState } from '@src/application/ui/tui/components/empty-state.tsx';
import { Spinner } from '@src/application/ui/tui/components/spinner.tsx';
import { StatusChip, sprintStatusKind } from '@src/application/ui/tui/components/status-chip.tsx';
import { ConfirmPrompt } from '@src/application/ui/tui/prompts/confirm-prompt.tsx';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { renameSprint, type Sprint } from '@src/domain/entity/sprint.ts';
import { useEditField } from '@src/application/ui/tui/runtime/use-edit-field.ts';
import { Result } from '@src/domain/result.ts';
import { spacing, glyphs, inkColors } from '@src/application/ui/tui/theme/tokens.ts';
import { useDeps } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { useAsyncLoad } from '@src/application/ui/tui/runtime/use-async-load.ts';
import { useRouter } from '@src/application/ui/tui/runtime/router.tsx';
import { useSelection } from '@src/application/ui/tui/runtime/selection-context.tsx';
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

export const SprintsView = (): React.JSX.Element => {
  const deps = useDeps();
  const router = useRouter();
  const selection = useSelection();
  const ui = useUiState();
  const sessions = useSessionManager();
  const queue = usePromptQueue();
  const storage = useStorage();
  useViewHints([
    { keys: '↵', label: 'open' },
    { keys: 'c', label: 'create' },
    { keys: 'e', label: 'rename' },
    { keys: 'd', label: 'delete' },
    { keys: 'r', label: 'reload' },
  ]);
  const edit = useEditField();

  const { state, reload } = useAsyncLoad<readonly Sprint[]>(async () => {
    const r = await deps.sprintRepo.list();
    if (!r.ok) throw new Error(r.error.message);
    const all = r.value;
    return selection.projectId !== undefined ? all.filter((s) => s.projectId === selection.projectId) : all;
  }, [selection.projectId]);

  const items = state.kind === 'ok' ? state.value : [];

  const [cursorId, setCursorId] = useState<SprintId | undefined>(undefined);
  const [confirmDelete, setConfirmDelete] = useState<Sprint | undefined>(undefined);
  const [feedback, setFeedback] = useState<string | undefined>(undefined);

  // Claim the global-key mute while the confirm prompt is mounted.
  useEffect(() => (confirmDelete !== undefined ? ui.claimPrompt() : undefined), [confirmDelete, ui.claimPrompt]);

  const launchCreateSprint = async (): Promise<void> => {
    if (selection.projectId === undefined) {
      setFeedback('✗ pick a project first (Projects → open one)');
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
    // v1 auto-selected a sprint as soon as it was created; v2 regressed. Subscribe to the
    // create-sprint runner so the moment its chain completes we read the new sprint off ctx
    // and update the selection — home view + downstream flows then pick it up automatically.
    // Late-subscribe replay (see chain/run/runner.ts) makes this race-free with `start()`.
    result.runner.subscribe((event) => {
      if (event.type !== 'completed') return;
      const ctx = event.ctx as { sprint?: { id: SprintId; name: string } };
      if (ctx.sprint !== undefined) {
        selection.setSprint(ctx.sprint.id, ctx.sprint.name);
      }
    });
    void result.runner.start();
    router.push({ id: 'execute', props: { sessionId: result.runner.id } });
  };

  const handleRename = (target: Sprint): void => {
    setFeedback(undefined);
    void edit.openEditPrompt({
      title: `Rename sprint "${target.name}"`,
      kind: 'short',
      currentValue: target.name,
      onSave: async (value) => {
        const renamed = renameSprint(target, value);
        if (!renamed.ok) return Result.error(renamed.error);
        const saved = await deps.sprintRepo.save(renamed.value);
        if (!saved.ok) return Result.error(saved.error);
        if (selection.sprintId === target.id) selection.setSprint(target.id, value.trim());
        reload();
        return Result.ok(undefined);
      },
      successLabel: `✓ renamed "${target.name}"`,
    });
  };

  useInput((input) => {
    if (ui.helpOpen || ui.promptActive || confirmDelete !== undefined) return;
    if (input === 'c') {
      void launchCreateSprint();
      return;
    }
    if (input === 'e') {
      const target = items.find((s) => s.id === cursorId) ?? items[0];
      if (target !== undefined && target.status !== 'done') handleRename(target);
      return;
    }
    if (input === 'd') {
      const target = items.find((s) => s.id === cursorId) ?? items[0];
      if (target !== undefined) setConfirmDelete(target);
      return;
    }
    if (input === 'r') {
      setFeedback('↻ reloading…');
      reload();
    }
  });

  const handleDeleteConfirmed = async (target: Sprint, confirmed: boolean): Promise<void> => {
    setConfirmDelete(undefined);
    if (!confirmed) return;
    const r = await deps.sprintRepo.remove(target.id);
    if (!r.ok) {
      setFeedback(`✗ ${r.error.message}`);
      return;
    }
    if (selection.sprintId === target.id) selection.setSprint(undefined);
    setFeedback(`✓ removed ${target.name}`);
    reload();
  };

  return (
    <ViewShell
      title="Sprints"
      subtitle={selection.projectId !== undefined ? 'scoped to current project' : 'all sprints across projects'}
    >
      {ui.helpOpen ? (
        <HelpOverlay />
      ) : state.kind === 'loading' || state.kind === 'idle' ? (
        <Box paddingX={spacing.indent}>
          <Spinner label="Loading sprints…" />
        </Box>
      ) : state.kind === 'error' ? (
        <Box paddingX={spacing.indent}>
          <Text>Failed to load sprints.</Text>
        </Box>
      ) : confirmDelete !== undefined ? (
        <Box flexDirection="column" paddingX={spacing.indent}>
          <Text>
            Remove sprint <Text bold>{confirmDelete.name}</Text>?
          </Text>
          <Text dimColor>
            Cascades to its execution record + tasks. Tickets stay in the sprint history if you re-create.
          </Text>
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
          title="No sprints yet"
          hint={
            selection.projectId === undefined
              ? 'Pick a project first (Projects view) then press c to create one.'
              : 'Press c to start the create-sprint flow.'
          }
          action={`c ${glyphs.arrowRight} create  ${glyphs.bullet}  esc ${glyphs.arrowRight} back`}
        />
      ) : (
        <Box flexDirection="column">
          <CardList
            items={state.value}
            visibleRows={4}
            active={!ui.promptActive && confirmDelete === undefined}
            onSelect={(s): void => {
              selection.setSprint(s.id, s.name);
              router.push({ id: 'sprint-detail', props: { sprintId: s.id } });
            }}
            onCursor={(s): void => setCursorId(s.id)}
            renderCard={(s, focused) => {
              const pending = s.tickets.filter((t) => t.status === 'pending').length;
              const approved = s.tickets.filter((t) => t.status === 'approved').length;
              return (
                <Box flexDirection="column">
                  <Box justifyContent="space-between">
                    <Text bold {...(focused ? { color: inkColors.primary } : {})}>
                      {s.name}
                    </Text>
                    <StatusChip label={s.status} kind={sprintStatusKind(s.status)} />
                  </Box>
                  <Text dimColor>{s.slug}</Text>
                  <Text>
                    <Text bold>{String(s.tickets.length)}</Text>
                    <Text dimColor> tickets</Text>
                    {pending > 0 && (
                      <Text>
                        <Text dimColor> {glyphs.bullet} </Text>
                        <Text bold color={inkColors.warning}>
                          {String(pending)}
                        </Text>
                        <Text dimColor> pending</Text>
                      </Text>
                    )}
                    {approved > 0 && (
                      <Text>
                        <Text dimColor> {glyphs.bullet} </Text>
                        <Text bold color={inkColors.success}>
                          {String(approved)}
                        </Text>
                        <Text dimColor> approved</Text>
                      </Text>
                    )}
                  </Text>
                </Box>
              );
            }}
          />
          <Box paddingX={spacing.indent} marginTop={spacing.section}>
            <Text dimColor>
              {glyphs.bullet} {state.value.length} sprint(s) {glyphs.bullet} ↵ open {glyphs.bullet} c create{' '}
              {glyphs.bullet} e rename {glyphs.bullet} d delete {glyphs.bullet} r reload
            </Text>
          </Box>
          {(feedback ?? edit.feedback) !== undefined && (
            <Box paddingX={spacing.indent} marginTop={1}>
              <Text color={(feedback ?? edit.feedback)?.startsWith('✗') ? inkColors.error : inkColors.primary}>
                {feedback ?? edit.feedback}
              </Text>
            </Box>
          )}
        </Box>
      )}
    </ViewShell>
  );
};
