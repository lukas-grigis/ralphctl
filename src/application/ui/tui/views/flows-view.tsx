/**
 * Flows view — single screen showing every flow registered with the application. Each row is
 * enabled iff its triggers match the current state; otherwise the row is dimmed and the reason
 * surfaces in the focused-item description.
 *
 * Selecting an enabled row launches the flow via {@link launchFlow}, registers the runner with
 * the session manager, and pushes the execute view with the new session id.
 */

import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { ViewShell } from '@src/application/ui/tui/components/view-shell.tsx';
import { Card } from '@src/application/ui/tui/components/card.tsx';
import { ActionMenu, type MenuItem } from '@src/application/ui/tui/components/action-menu.tsx';
import { Spinner } from '@src/application/ui/tui/components/spinner.tsx';
import { Badge } from '@src/application/ui/tui/components/badge.tsx';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { flowRegistry } from '@src/application/registry.ts';
import { evaluateTriggers } from '@src/application/registry-triggers.ts';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { useDeps } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { useSelection } from '@src/application/ui/tui/runtime/selection-context.tsx';
import { useAsyncLoad } from '@src/application/ui/tui/runtime/use-async-load.ts';
import { loadAppStateSnapshot, type AppStateSnapshot } from '@src/application/ui/shared/state-snapshot.ts';
import { useRouter, type ViewEntry } from '@src/application/ui/tui/runtime/router.tsx';
import { useSessionManager } from '@src/application/ui/tui/runtime/sessions-context.tsx';
import { usePromptQueue } from '@src/application/ui/tui/prompts/prompt-context.tsx';
import { createInkInteractivePrompt } from '@src/application/ui/tui/prompts/ink-interactive-prompt.ts';
import { useStorage } from '@src/application/ui/tui/runtime/storage-context.tsx';
import { useViewHints } from '@src/application/ui/tui/runtime/use-view-hints.tsx';
import {
  launchFlow,
  modelForFlow,
  modelsForFlowProvider,
  sessionHintsFromLaunchResult,
} from '@src/application/ui/shared/launcher.ts';
import type { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import { getRunInTerminal } from '@src/application/ui/tui/runtime/run-in-terminal.ts';
import { HelpOverlay } from '@src/application/ui/tui/components/help-overlay.tsx';
import { SprintPipeline } from '@src/application/ui/tui/components/sprint-pipeline.tsx';
import { sectionFor, sectionRank, visibleFlowsFor } from '@src/application/ui/tui/views/flows-visibility.ts';

// Sprint-state-machine visibility lives in `flows-visibility.ts` so it can be unit-tested
// without a React render. The view delegates section labelling, ordering, and the
// per-status allow-list to that module.

/**
 * Some flows in the registry are use-case shaped (one-shot, no chain runner) and the TUI
 * has dedicated views for them. Route those directly instead of falling through to
 * `launchFlow`, which only knows how to construct chain flows.
 */
const viewRouteFor = (flowId: string, snapshot: AppStateSnapshot): ViewEntry | undefined => {
  switch (flowId) {
    case 'doctor':
      return { id: 'doctor' };
    case 'settings':
      return { id: 'settings' };
    case 'ticket-add':
    case 'ticket-remove':
      return snapshot.sprint ? { id: 'sprint-detail', props: { sprintId: snapshot.sprint.id } } : undefined;
    case 'export-context':
      return { id: 'export-context' };
    case 'export-requirements':
      return { id: 'export-requirements' };
    case 'create-pr':
      return { id: 'create-pr' };
    default:
      return undefined;
  }
};

export const FlowsView = (): React.JSX.Element => {
  const ui = useUiState();
  const deps = useDeps();
  const selection = useSelection();
  const router = useRouter();
  const sessions = useSessionManager();
  const queue = usePromptQueue();
  const storage = useStorage();
  const [launchError, setLaunchError] = useState<string | undefined>(undefined);
  const [showAll, setShowAll] = useState<boolean>(false);
  useViewHints([
    { keys: '↵', label: 'launch' },
    { keys: 'r', label: 'reload state' },
    { keys: 'v', label: showAll ? 'hide inapplicable' : 'show all' },
  ]);

  const { state, reload } = useAsyncLoad<AppStateSnapshot>(
    () =>
      loadAppStateSnapshot(
        { projectRepo: deps.projectRepo, sprintRepo: deps.sprintRepo, taskRepo: deps.taskRepo },
        {
          ...(selection.projectId !== undefined ? { projectId: selection.projectId } : {}),
          ...(selection.sprintId !== undefined ? { sprintId: selection.sprintId } : {}),
        }
      ),
    [selection.projectId, selection.sprintId]
  );

  const items = useMemo<readonly MenuItem[]>(() => {
    if (state.kind !== 'ok') return [];
    const snapshot = state.value;
    // State-machine visibility: hide sprint-scoped flows that don't apply to the current
    // sprint status (or hide them all when no sprint is selected). `showAll` toggles every
    // flow back into view so the user can see what's reachable in other states — those
    // rows stay dimmed via `evaluateTriggers`.
    const visible = visibleFlowsFor({
      hasProject: snapshot.project !== undefined,
      ...(snapshot.sprint !== undefined ? { sprintStatus: snapshot.sprint.status } : {}),
      showAll,
    });
    const filteredRegistry = flowRegistry.filter((entry) => visible.has(entry.manifest.id));
    const built = filteredRegistry.map((entry): MenuItem => {
      const triggerEval = evaluateTriggers(entry.manifest.triggers, snapshot.triggerInputs);
      const item: MenuItem = {
        id: entry.manifest.id,
        section: sectionFor(entry.manifest.id),
        label: entry.manifest.title,
        description: entry.manifest.description,
        onSelect: async (): Promise<void> => {
          setLaunchError(undefined);

          // Use-case-shaped flows (doctor, settings-*, ticket-*) don't go through the chain
          // launcher — they have dedicated views. Route there directly.
          const route = viewRouteFor(entry.manifest.id, snapshot);
          if (route !== undefined) {
            router.push(route);
            return;
          }

          const interactive = createInkInteractivePrompt(queue);

          // Re-read settings from disk now so provider/model changes made via the Settings
          // view propagate. `deps.settings` is the boot-time snapshot and goes stale across
          // any settings write; the on-disk repo is the source of truth.
          const freshSettings = await deps.settingsRepo.load();
          const settings = freshSettings.ok ? freshSettings.value : deps.settings;

          // Pre-launch model picker — for AI-driven flows, offer the configured default first
          // (Enter starts immediately), with a "Pick a different model…" option that opens a
          // nested SelectPrompt. Non-AI flows skip this step entirely. The override is single-
          // use; the next launch falls back to the settings default again. Settings is the
          // place for permanent changes.
          const defaultModel = modelForFlow(entry.manifest.id, settings);
          let modelOverride: string | undefined;
          if (defaultModel !== undefined) {
            const action = await interactive.askChoice<'start' | 'pick' | 'cancel'>(
              `Run ${entry.manifest.title} with model '${defaultModel}'?`,
              [
                { label: `Start (use ${defaultModel})`, value: 'start' },
                { label: 'Pick a different model…', value: 'pick' },
                { label: 'Cancel', value: 'cancel' },
              ]
            );
            if (!action.ok || action.value === 'cancel') return;
            if (action.value === 'pick') {
              const models = modelsForFlowProvider(entry.manifest.id, settings);
              const picked = await interactive.askChoice<string>(
                'Choose model for this run (does not change settings):',
                models.map((m) => ({ label: m, value: m, ...(m === defaultModel ? { description: '(default)' } : {}) }))
              );
              if (!picked.ok) return;
              modelOverride = picked.value;
            }
          }

          // Thread the session-pinned repository id as a pre-selection so flows that pick a
          // repo (detect-scripts / detect-skills / readiness) skip the prompt after the first
          // pick of the session. First launch leaves extras empty → the user picks → the
          // runner emits `completed` with the chosen `ctx.repository` and we record it below.
          const result = await launchFlow(
            { app: deps, interactive, storage, runInTerminal: getRunInTerminal() },
            entry.manifest.id,
            snapshot,
            {
              ...(ui.sessionRepositoryId !== undefined ? { repositoryId: ui.sessionRepositoryId } : {}),
              ...(modelOverride !== undefined ? { modelOverride } : {}),
              settingsSnapshot: settings,
            }
          );
          if (!result.ok) {
            setLaunchError(`${entry.manifest.title}: ${result.reason}`);
            return;
          }
          // Subscribe BEFORE start() so we don't miss the synchronous completion of a
          // fast-path flow. Capture the chosen repository id from the final ctx for
          // subsequent launches in this session.
          result.runner.subscribe((event) => {
            if (event.type !== 'completed') return;
            const ctx = event.ctx as { readonly repository?: { readonly id: RepositoryId } };
            if (ctx.repository !== undefined) ui.setSessionRepositoryId(ctx.repository.id);
          });
          sessions.register({
            runner: result.runner,
            flowId: entry.manifest.id,
            title: result.title,
            ...sessionHintsFromLaunchResult(result),
          });
          // Fire-and-forget — events flow into the session manager via subscribe.
          void result.runner.start();
          router.replace({ id: 'execute', props: { sessionId: result.runner.id } });
          reload();
        },
      };
      if (!triggerEval.enabled) return { ...item, disabledReason: triggerEval.reason };
      return item;
    });
    // Sort by section so the action menu's section headers stay sticky (items in the same
    // category render consecutively even when registry order interleaves them).
    return [...built].sort((a, b) => sectionRank(a.section ?? 'other') - sectionRank(b.section ?? 'other'));
  }, [state, deps, queue, storage, sessions, router, reload, showAll, ui]);

  // `r` re-fetches the snapshot so the menu's enabled/disabled state reflects the latest
  // storage read — useful after mutating something in a detail view and coming back. `v`
  // (visibility) toggles between the state-machine-filtered menu (default) and the full
  // registry; `s` is intentionally NOT used here because Home reserves it for Settings.
  useInput((input) => {
    if (ui.helpOpen || ui.promptActive) return;
    if (input === 'r') reload();
    if (input === 'v') setShowAll((v) => !v);
  });

  return (
    <ViewShell title="Flows" subtitle="Pick a flow to run">
      {ui.helpOpen ? (
        <HelpOverlay />
      ) : state.kind !== 'ok' ? (
        <Box paddingX={spacing.indent}>
          <Spinner label="Loading state…" />
        </Box>
      ) : (
        <Box flexDirection="column">
          <SprintPipeline snapshot={state.value} />
          <Box marginTop={state.value.sprint !== undefined ? spacing.section : 0}>
            <Card title="Eligibility" tone="rule">
              <Box>
                <Text dimColor>
                  Flows are filtered by the current sprint state. Press <Text bold>v</Text> to{' '}
                  {showAll ? 'hide inapplicable flows' : 'show every flow with disabled reasons'}.
                </Text>
              </Box>
              <Box marginTop={1}>
                <Text dimColor>
                  {glyphs.bullet} Project:{' '}
                  <Badge kind={state.value.project ? 'success' : 'warning'}>
                    {state.value.project?.displayName ?? '(none)'}
                  </Badge>
                  {'   '}
                  {glyphs.bullet} Sprint:{' '}
                  <Badge kind={state.value.sprint ? 'success' : 'warning'}>
                    {state.value.sprint?.name ?? '(none)'}
                  </Badge>
                </Text>
              </Box>
            </Card>
          </Box>
          <Box marginTop={spacing.section}>
            <ActionMenu items={items} active={!ui.promptActive} />
          </Box>
          {launchError !== undefined && (
            <Box paddingX={spacing.indent} marginTop={spacing.section}>
              <Text color={inkColors.error}>
                {glyphs.bullet} {launchError}
              </Text>
            </Box>
          )}
          <Box marginTop={spacing.section} paddingX={spacing.indent}>
            <Text dimColor>↵ launch · v {showAll ? 'hide inapplicable' : 'show all'} · esc back · h home</Text>
          </Box>
        </Box>
      )}
    </ViewShell>
  );
};
