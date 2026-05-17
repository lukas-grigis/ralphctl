/**
 * TUI bootstrap. Resolves storage paths, ensures roots exist, loads settings, builds the
 * harness signal bus + the log entry bus (the latter populated from the EventBus's `'log'`
 * AppEvents), wires deps, then renders App with everything threaded in.
 *
 * Pre-render errors fall through to a tiny stderr message + non-zero exit so the operator
 * sees exactly what went wrong without staring at a blank Ink frame.
 *
 * Doctor probes are not run here — `HomeView` re-runs them on every mount so the banner
 * reflects the current state (e.g. right after the welcome flow saves settings).
 */

import React from 'react';
import type { HarnessSignal } from '@src/domain/signal.ts';
import type { LogEvent } from '@src/business/observability/events.ts';
import type { HarnessSignalSink } from '@src/integration/ai/signals/_engine/sink.ts';
import type { AppSinks } from '@src/application/bootstrap/runtime-sinks.ts';
import { ensureStorageRoots, resolveStoragePaths } from '@src/application/bootstrap/storage-paths.ts';
import { detectLegacyLayout, renderLegacyLayoutMessage } from '@src/application/bootstrap/legacy-layout-detector.ts';
import { createJsonSettingsRepository } from '@src/integration/persistence/settings/json-settings-repository.ts';
import { wire } from '@src/application/bootstrap/wire.ts';
import { broadcastSink } from '@src/integration/observability/sinks/broadcast-sink.ts';
import { createBusSink } from '@src/application/ui/tui/runtime/sinks-bus.ts';
import { createSessionManager } from '@src/application/ui/tui/runtime/session-manager.ts';
import { createPromptQueue } from '@src/application/ui/tui/prompts/prompt-queue.ts';
import { createInkInteractivePrompt } from '@src/application/ui/tui/prompts/ink-interactive-prompt.ts';
import { createInkHost } from '@src/application/ui/shared/ink-host.ts';
import { setRunInTerminal } from '@src/application/ui/tui/runtime/run-in-terminal.ts';
import { App } from '@src/application/ui/tui/App.tsx';
import { resolveInitialState } from '@src/application/ui/tui/launch-routing.ts';
import { createLastSelectionStore } from '@src/integration/persistence/selection/last-selection-store.ts';

interface Bootstrapped {
  readonly app: Parameters<typeof App>[0];
  readonly drain: () => void;
}

const bootstrap = async (): Promise<Bootstrapped> => {
  const paths = resolveStoragePaths();
  if (!paths.ok) throw new Error(`storage-paths: ${paths.error.message}`);

  // Legacy-layout check runs BEFORE ensureStorageRoots and BEFORE the Ink mount so
  // the user sees the recovery message on the regular terminal (alt-screen hasn't
  // engaged yet). On hit we exit non-zero.
  const legacy = await detectLegacyLayout(paths.value.appRoot);
  if (legacy.kind === 'legacy-v0.6') {
    process.stderr.write(renderLegacyLayoutMessage(legacy));
    process.exit(1);
  }

  const ensured = await ensureStorageRoots(paths.value);
  if (!ensured.ok) throw new Error(`ensure-roots: ${ensured.error.message}`);

  const settingsRepo = createJsonSettingsRepository({ configRoot: paths.value.configRoot });
  const settings = await settingsRepo.load();
  if (!settings.ok) throw new Error(`settings: ${settings.error.message}`);

  // The harness signal sink reaches the chain layer via `wire()`; the log bus is
  // populated below by subscribing to the wired EventBus's `'log'` events.
  const harnessBus = createBusSink<HarnessSignal>({ maxEntries: 1000 });
  const logBus = createBusSink<LogEvent>({ maxEntries: 2000 });
  const harnessSink: HarnessSignalSink = broadcastSink<HarnessSignal>([harnessBus]);

  const sinks: AppSinks = { harness: harnessSink };
  const deps = wire({ storage: paths.value, sinks, settings: settings.value });

  // Forward EventBus 'log' events into the TUI's log bus so the recent-events-tail panel
  // keeps rendering. Capture the unsubscribe so the bootstrap's `drain()` (called from
  // launchTui's finally on Ink shutdown) can release the listener — otherwise a re-launched
  // TUI in the same Node process would stack a fresh forwarder on top of the dead one and
  // each 'log' event would publish twice (or N times after N relaunches).
  const unsubLogForward = deps.eventBus.subscribe((event) => {
    if (event.type === 'log') logBus.emit(event);
  });

  const sessions = createSessionManager();
  const queue = createPromptQueue();

  // The Ink prompt adapter is plumbed through deps that the launcher reads; chain factories
  // that need an `InteractivePrompt` (create-sprint, add-tickets, readiness) get this
  // adapter via the launcher.
  void createInkInteractivePrompt(queue);

  // First-run detection lives in launch-routing.ts as a pure function. Here we resolve the
  // side-effecting inputs (settings + projects + persisted last-selection) and hand them off.
  const settingsExists = await deps.settingsRepo.exists();
  const projectsList = await deps.projectRepo.list();
  const lastSelectionStore = createLastSelectionStore(paths.value.stateRoot);
  const lastSelection = await lastSelectionStore.read();
  const { initialView, initialSelection } = resolveInitialState({
    settingsExist: settingsExists.ok ? settingsExists.value : false,
    projects: projectsList.ok ? projectsList.value : [],
    ...(lastSelection !== undefined ? { lastProjectId: lastSelection.projectId } : {}),
    ...(lastSelection?.sprintId !== undefined ? { lastSprintId: lastSelection.sprintId } : {}),
  });

  return {
    app: {
      deps,
      storage: paths.value,
      buses: { harness: harnessBus, log: logBus },
      sessions,
      queue,
      initialView,
      ...(initialSelection !== undefined ? { initialSelection } : {}),
      onSelectionChange: (next): void => {
        void lastSelectionStore.write(
          next.projectId !== undefined
            ? {
                projectId: next.projectId,
                ...(next.projectLabel !== undefined ? { projectLabel: next.projectLabel } : {}),
                ...(next.sprintId !== undefined ? { sprintId: next.sprintId } : {}),
              }
            : undefined
        );
      },
    },
    drain: (): void => {
      queue.drain(new Error('TUI shutting down'));
      unsubLogForward();
    },
  };
};

export const launchTui = async (): Promise<void> => {
  let booted: Bootstrapped;
  try {
    booted = await bootstrap();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`ralphctl: failed to start TUI — ${msg}\n`);
    process.exitCode = 1;
    return;
  }

  const appElement = React.createElement(App, booted.app);
  const host = createInkHost({ appElement });
  setRunInTerminal(host.runInTerminal);
  try {
    await host.waitForShutdown();
  } finally {
    booted.drain();
  }
};
