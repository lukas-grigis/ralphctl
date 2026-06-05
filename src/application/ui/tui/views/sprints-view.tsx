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
import { OverflowRow, useListWindow } from '@src/application/ui/tui/components/windowed-list.tsx';
import { EmptyState } from '@src/application/ui/tui/components/empty-state.tsx';
import { Spinner } from '@src/application/ui/tui/components/spinner.tsx';
import { sprintStatusKind, StatusChip } from '@src/application/ui/tui/components/status-chip.tsx';
import { ConfirmPrompt } from '@src/application/ui/tui/prompts/confirm-prompt.tsx';
import { renameSprint, type Sprint } from '@src/domain/entity/sprint.ts';
import { useEditField } from '@src/application/ui/tui/runtime/use-edit-field.ts';
import { Result } from '@src/domain/result.ts';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
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
import { sessionHintsFromLaunchResult } from '@src/application/ui/shared/launcher.ts';
import { launchSprintBoundFlow } from '@src/application/ui/shared/launch/sprint-bound.ts';
import { loadAppStateSnapshot } from '@src/application/ui/shared/state-snapshot.ts';
import { HelpOverlay } from '@src/application/ui/tui/components/help-overlay.tsx';
import { useBreakpoint } from '@src/application/ui/tui/runtime/use-breakpoint.ts';
import { unblockTaskUseCase } from '@src/business/task/unblock-task.ts';
import type { Task } from '@src/domain/entity/task.ts';

export const SprintsView = (): React.JSX.Element => {
  const deps = useDeps();
  const router = useRouter();
  const selection = useSelection();
  const ui = useUiState();
  const { rows } = useBreakpoint();
  const sessions = useSessionManager();
  const queue = usePromptQueue();
  const storage = useStorage();
  const edit = useEditField();

  const { state, reload } = useAsyncLoad<readonly Sprint[]>(async () => {
    const r = await deps.sprintRepo.list();
    if (!r.ok) throw new Error(r.error.message);
    const scoped =
      selection.projectId !== undefined ? r.value.filter((s) => s.projectId === selection.projectId) : r.value;
    // sprintRepo.list() returns ids ascending (UUIDv7 ≈ creation order); reverse to newest-first
    // so this list matches the home view and the cross-project picker. Copy before sorting —
    // r.value may alias the repository's own array.
    return [...scoped].sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  }, [selection.projectId]);

  const items = state.kind === 'ok' ? state.value : [];

  const [confirmDelete, setConfirmDelete] = useState<Sprint | undefined>(undefined);
  const [feedback, setFeedback] = useState<string | undefined>(undefined);

  // Windowed cursor — owns ↑/↓ + j/k + PgUp/PgDn + Home/End + Enter; the cursor is the sprint id,
  // so a reload/reorder keeps focus on the same sprint. Enter selects (sets current + drills in).
  // Disabled while a prompt/help/confirm is up so its keys don't fight the modal.
  const listActive = !ui.promptActive && !ui.helpOpen && confirmDelete === undefined;
  const visibleRows = Math.max(4, Math.min(12, Math.floor(rows / 5)));
  const { window, visibleItems, focusedIndex, focusedItem } = useListWindow<Sprint>({
    items,
    getId: (s) => s.id,
    visibleRows,
    active: listActive,
    onSubmit: (s) => {
      selection.setSprint(s.id, s.name, s.status);
      router.push({ id: 'sprint-detail', props: { sprintId: s.id } });
    },
  });

  // Load tasks for the focused sprint so we can count stuck ones (blocked + in_progress) and
  // offer `u` to bulk-unblock them. Keyed by sprint id so cursor moves re-trigger the fetch.
  const [focusedSprintTasks, setFocusedSprintTasks] = useState<readonly Task[]>([]);
  const focusedSprint = focusedItem ?? items[0];
  useEffect(() => {
    if (focusedSprint === undefined) {
      setFocusedSprintTasks([]);
      return undefined;
    }
    let cancelled = false;
    const load = async (): Promise<void> => {
      const r = await deps.taskRepo.findBySprintId(focusedSprint.id);
      if (cancelled) return;
      if (r.ok) setFocusedSprintTasks(r.value);
    };
    load().catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // `focusedSprint?.id` is the only piece of focusedSprint we read; depending on the full
    // object would re-fire whenever the sprint list reloads with semantically-identical data.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- id is the load axis
  }, [focusedSprint?.id, deps.taskRepo]);

  const stuckTasks = focusedSprintTasks.filter((t) => t.status === 'blocked' || t.status === 'in_progress');
  const stuckCount = stuckTasks.length;

  // `e rename` shares one source of truth with its handler: the rename chord guards
  // `status !== 'done'` (a done sprint is immutable), so the hint must hide on a done sprint
  // rather than advertise a no-op. `u` follows the same declarative gate on the stuck-task count.
  const focusedDone = focusedSprint?.status === 'done';
  useViewHints([
    { keys: '↵', label: 'open' },
    { keys: 'c', label: 'create' },
    { keys: 'e', label: 'rename', enabledWhen: !focusedDone },
    { keys: 'd', label: 'delete' },
    { keys: 'r', label: 'reload' },
    { keys: 'u', label: `unblock (${String(stuckCount)})`, enabledWhen: stuckCount > 0 },
  ]);

  // Claim the global-key mute while the confirm prompt is mounted.
  const claimPrompt = ui.claimPrompt;
  useEffect(() => (confirmDelete !== undefined ? claimPrompt() : undefined), [confirmDelete, claimPrompt]);

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
    // The shared sprint-bound launcher owns the post-completion `selection.setSprint` reseat
    // — wiring it inline here would duplicate the subscriber across every sprint-bound view.
    const result = await launchSprintBoundFlow(
      { app: deps, interactive, storage, runInTerminal: getRunInTerminal() },
      'create-sprint',
      snapshot,
      {
        onReseat: ({ id, name, status }) => {
          selection.setSprint(id, name, status);
        },
        onSprintResolved: (runnerId, { id, name }) => {
          sessions.setPinnedSprint(runnerId, id, name);
        },
      }
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
        if (selection.sprintId === target.id) selection.setSprint(target.id, value.trim(), target.status);
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
      const target = focusedSprint;
      if (target === undefined) return;
      // A done sprint is immutable, so the rename chord (and its hint) are gated off. Someone who
      // found `e` via the `?` overlay still presses it — flash a reason so the key isn't a mystery
      // no-op rather than silently swallowing the keystroke.
      if (target.status === 'done') {
        setFeedback(`${glyphs.cross} done sprints can't be renamed`);
        return;
      }
      handleRename(target);
      return;
    }
    if (input === 'd') {
      const target = focusedSprint;
      if (target !== undefined) setConfirmDelete(target);
      return;
    }
    if (input === 'r') {
      setFeedback('↻ reloading…');
      reload();
    }
    if (input === 'u' && stuckCount > 0) {
      void handleBulkUnblock();
    }
  });

  const handleBulkUnblock = async (): Promise<void> => {
    if (focusedSprint === undefined || stuckTasks.length === 0) return;
    setFeedback(undefined);
    let succeeded = 0;
    let lastError: string | undefined;
    for (const task of stuckTasks) {
      const r = await unblockTaskUseCase({
        task,
        sprintId: focusedSprint.id,
        taskRepo: deps.taskRepo,
        sprintRepo: deps.sprintRepo,
        clock: deps.clock,
        logger: deps.logger,
      });
      if (r.ok) {
        succeeded += 1;
      } else {
        lastError = r.error.message;
      }
    }
    const total = stuckTasks.length;
    if (succeeded === total) {
      setFeedback(
        `${glyphs.check} unblocked ${String(succeeded)} task${succeeded === 1 ? '' : 's'} in "${focusedSprint.name}"`
      );
    } else {
      setFeedback(
        `${glyphs.check} unblocked ${String(succeeded)} of ${String(total)}${lastError !== undefined ? ` — ${lastError}` : ''}`
      );
    }
    // Refresh task list so the hint and count update immediately.
    const refreshed = await deps.taskRepo.findBySprintId(focusedSprint.id);
    if (refreshed.ok) setFocusedSprintTasks(refreshed.value);
  };

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
      suppressScrollArrows
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
          <Box flexDirection="column">
            <OverflowRow direction="above" count={window.start} />
            {visibleItems.map((s, localIdx) => {
              const focused = window.start + localIdx === focusedIndex;
              const pending = s.tickets.filter((t) => t.status === 'pending').length;
              const approved = s.tickets.filter((t) => t.status === 'approved').length;
              return (
                <Box key={s.id} flexDirection="column" marginBottom={1}>
                  <Box
                    flexDirection="column"
                    borderStyle="round"
                    borderColor={focused ? inkColors.primary : inkColors.rule}
                    borderDimColor={!focused}
                    paddingX={spacing.cardPadX}
                  >
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
                </Box>
              );
            })}
            <OverflowRow direction="below" count={state.value.length - window.end} />
          </Box>
          {/* Just the count here — the key affordances live in the router's hint strip
              (`useViewHints`), the single source of truth that gates `e`/`u` on focus state.
              Duplicating the keys inline would re-advertise them ungated and contradict the gate. */}
          <Box paddingX={spacing.indent} marginTop={spacing.section}>
            <Text dimColor>
              {glyphs.bullet} {state.value.length} sprint(s)
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
