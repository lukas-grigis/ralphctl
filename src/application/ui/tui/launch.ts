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
import type { HarnessSignalSink } from '@src/business/observability/harness-signal-sink.ts';
import type { AppSinks } from '@src/application/bootstrap/runtime-sinks.ts';
import { ensureStorageRoots, resolveStoragePaths } from '@src/application/bootstrap/storage-paths.ts';
import { detectLegacyLayout, renderLegacyLayoutMessage } from '@src/application/bootstrap/legacy-layout-detector.ts';
import { createJsonSettingsRepository } from '@src/integration/persistence/settings/json-settings-repository.ts';
import { type AppDeps, wire } from '@src/application/bootstrap/wire.ts';
import { broadcastSink } from '@src/integration/observability/sinks/broadcast-sink.ts';
import { type BusSink, createBusSink } from '@src/application/ui/tui/runtime/sinks-bus.ts';
import { type CoalescedBuffer, createCoalescedBuffer } from '@src/application/ui/tui/runtime/coalesced-buffer.ts';
import { createSessionManager } from '@src/application/ui/tui/runtime/session-manager.ts';
import { createPromptQueue } from '@src/application/ui/tui/prompts/prompt-queue.ts';
import { createInkInteractivePrompt } from '@src/application/ui/tui/prompts/ink-interactive-prompt.ts';
import { createInkHost } from '@src/application/ui/shared/ink-host.ts';
import { setRunInTerminal } from '@src/application/ui/tui/runtime/run-in-terminal.ts';
import { setImplementRoleOverrides } from '@src/application/ui/tui/runtime/implement-role-overrides.ts';
import type { LaunchExtras } from '@src/application/ui/shared/launcher.ts';
import { App } from '@src/application/ui/tui/App.tsx';
import { resolveInitialState } from '@src/application/ui/tui/launch-routing.ts';
import { createLastSelectionStore } from '@src/integration/persistence/selection/last-selection-store.ts';
import { type LogLevelGate, createLogLevelGate, passesLogLevel } from '@src/business/observability/log-level-filter.ts';
import { startHeapWatchdog } from '@src/integration/observability/heap-watchdog.ts';
import { writeHeapSnapshotToDir } from '@src/integration/observability/heap-snapshot.ts';
import { createOsNotificationDispatcher } from '@src/integration/observability/os-notification-dispatcher.ts';
import { startNotificationSubscriber } from '@src/business/observability/notification-subscriber.ts';

interface Bootstrapped {
  readonly app: Parameters<typeof App>[0];
  readonly drain: () => void;
}

/**
 * Build the EventBus-`log` → logBus forwarder. This forwarder is the UI-floor chokepoint: the
 * log-level gate is applied HERE, at ingest, against the live gate (`gate.get()` per event) —
 * providers publish every stream-json line to the EventBus verbatim, so this is the single place
 * that drops sub-floor events before they reach the UI. (The persistent events.ndjson sink writes
 * them regardless of floor.)
 *
 * Admitted events are pushed through a CoalescedBuffer rather than emitted one-by-one: at a DEBUG
 * floor a long run fans thousands of lines/sec, and one `logBus.emit` per line drove one React
 * commit per line in `useSinkStream` → unthrottled Yoga layout → OOM. The buffer delivers a
 * trailing window at most ~16fps; each flush emits its batch into `logBus` inside one synchronous
 * turn so the downstream setStates collapse into a single commit.
 *
 * Returns the buffer (for `flushNow` on heap-critical + `stop` on drain) and the bus-unsubscribe
 * (so a re-launched TUI in the same Node process does not stack a second forwarder on the dead one
 * and double-publish every event).
 */
const createLogForwarder = (
  eventBus: AppDeps['eventBus'],
  logBus: BusSink<LogEvent>,
  gate: LogLevelGate
): { readonly buffer: CoalescedBuffer<LogEvent>; readonly unsubscribe: () => void } => {
  const buffer = createCoalescedBuffer<LogEvent>({
    limit: 2000,
    // Delta semantics: this forwarder re-emits each window value into `logBus`. A rolling window
    // would re-emit prior-flush events every tick and re-grow the bus (the OOM we are fixing), so
    // each flush must deliver only the events admitted since the previous flush.
    clearOnFlush: true,
    onFlush: (window) => {
      for (const event of window) logBus.emit(event);
    },
  });
  const unsubscribe = eventBus.subscribe((event) => {
    if (event.type === 'log' && passesLogLevel(event.level, gate.get())) buffer.push(event);
  });
  return { buffer, unsubscribe };
};

/**
 * Build the heap-watchdog `onCritical` callback. Captured into its own factory so `bootstrap`
 * stays lean and the post-mortem logic is testable/readable in isolation. The snapshot is the
 * real diagnostic (it names the dominant retainer); the buffer-clear is just defensive — those
 * buffers are small-capped so clearing them frees little. Must never throw.
 */
const createHeapCriticalHandler = (args: {
  readonly logger: AppDeps['logger'];
  readonly logForwarder: CoalescedBuffer<LogEvent>;
  readonly harnessBus: BusSink<HarnessSignal>;
  readonly logBus: BusSink<LogEvent>;
}): (() => void) => {
  const { logger, logForwarder, harnessBus, logBus } = args;
  return () => {
    // Defensive buffer-clear: synchronous, fast in-memory ops — run these first so memory is
    // reclaimed immediately (before the snapshot write steals time). Drop (do NOT flush) the
    // batch the forwarder is holding; flushing would re-emit into `logBus` immediately before
    // we empty it — pointless churn. discard() empties the window without emitting.
    logForwarder.discard();
    harnessBus.clear();
    logBus.clear();

    // Heap snapshot deferred off the hot path via setImmediate. v8.writeHeapSnapshot() is a
    // synchronous V8 operation that blocks the Node.js event loop for several seconds on large
    // heaps — manifesting as a complete TUI freeze if called here synchronously. Deferring with
    // setImmediate gives the event loop one turn to process any pending work (re-render, GC
    // from the buffer clears above) before we block it. The snapshot is purely diagnostic; a
    // one-tick delay has no operational impact.
    setImmediate(() => {
      const snapshot = writeHeapSnapshotToDir('.diagnostics');
      if (snapshot.ok) {
        logger.warn(
          `heap critical — wrote heap snapshot to ${snapshot.path}; ` +
            'open it in Chrome DevTools › Memory to find the dominant retainer'
        );
      } else {
        logger.error(`heap critical — could not write heap snapshot: ${snapshot.error}`);
      }
    });
  };
};

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

  // Forward EventBus 'log' events into the TUI's log bus (coalesced, gate-at-ingest). See
  // createLogForwarder for the full rationale. Log-level gate is a small mutable holder seeded
  // from `settings.logging.level`; the Settings view swaps the floor at runtime via
  // `gate.set(newLevel)` through the LogLevelContext, and the forwarder reads it per event.
  const logLevelGate = createLogLevelGate(settings.value.logging.level);
  const { buffer: logForwarder, unsubscribe: unsubLogForward } = createLogForwarder(
    deps.eventBus,
    logBus,
    logLevelGate
  );

  // Heap watchdog gives the operator a warning before V8 SIGKILLs the harness on a long-running
  // session. On 'critical' its real value is capturing a heap snapshot for post-mortem: the
  // TUI's in-memory buffers are small-capped (a few MB), so clearing them frees little — the
  // OOM recurs undiagnosed unless we name the dominant retainer. The snapshot does that.
  const heapWatchdog = startHeapWatchdog({
    eventBus: deps.eventBus,
    onCritical: createHeapCriticalHandler({ logger: deps.logger, logForwarder, harnessBus, logBus }),
  });

  // OS-attention notifications. Wired here (not inside wire()) so tests that build wire() never
  // accidentally pop NotificationCenter dings on the dev machine — only the TUI bootstrap
  // attaches the real adapter + subscriber. Disable gate reads the boot-time settings snapshot
  // (a runtime toggle requires relaunch; see wire.ts comment).
  const osNotificationDispatcher = createOsNotificationDispatcher({ logger: deps.logger });
  const unsubNotifications = startNotificationSubscriber({
    eventBus: deps.eventBus,
    dispatcher: osNotificationDispatcher,
    disabled: () => settings.value.ui.notifications.enabled === false,
  });

  const sessions = createSessionManager();
  const queue = createPromptQueue();

  // The Ink prompt adapter is plumbed through deps that the launcher reads; chain factories
  // that need an `InteractivePrompt` (create-sprint, readiness) get this
  // adapter via the launcher.
  void createInkInteractivePrompt(queue);

  // First-run detection lives in launch-routing.ts as a pure function. Here we resolve the
  // side-effecting inputs (settings + projects + persisted last-selection) and hand them off.
  const settingsExists = await deps.settingsRepo.exists();
  const projectsList = await deps.projectRepo.list();
  const sprintsResult = await deps.sprintRepo.list();
  const lastSelectionStore = createLastSelectionStore(paths.value.stateRoot);
  const lastSelection = await lastSelectionStore.read();
  const { initialView, initialSelection } = resolveInitialState({
    settingsExist: settingsExists.ok ? settingsExists.value : false,
    projects: projectsList.ok ? projectsList.value : [],
    sprints: sprintsResult.ok ? sprintsResult.value : [],
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
      logLevelGate,
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
      logForwarder.stop();
      heapWatchdog.stop();
      unsubNotifications();
    },
  };
};

export interface LaunchTuiOptions {
  /**
   * Per-launch overrides for `settings.ai.implement` — parsed from the bare-`ralphctl`
   * `--implement-{generator,evaluator}-{provider,model}` flags. Stored on the module-level
   * holder so the TUI's `flows-view` reads them when assembling the implement {@link
   * LaunchExtras}; cleared on every fresh launch so a prior run's overrides don't leak.
   */
  readonly implementRoleOverrides?: LaunchExtras['implementRoleOverrides'];
}

export const launchTui = async (options: LaunchTuiOptions = {}): Promise<void> => {
  // TTY pre-flight. Ink's raw-mode input fails *post-mount* inside its useInput effect on a
  // non-TTY stdin (pipe / CI / cron), which bypasses bootstrap's catch and dumps ~2KB of
  // react-reconciler frames to stdout while exiting 0. Bail before mounting with a one-line
  // stderr hint and a non-zero exit so wrapping scripts see a real failure. (This is the named
  // exception to the "mount is unconditional" invariant in CLAUDE.md.)
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(
      'ralphctl: the interactive TUI requires a terminal — run inside a TTY, ' +
        'or use a subcommand (ralphctl --help) for non-interactive use\n'
    );
    process.exitCode = 1;
    return;
  }

  // Reset the holder on every launch so a prior `launchTui(...)` call's overrides don't leak
  // into the next; production runs are one-shot processes but tests reuse the holder.
  setImplementRoleOverrides(options.implementRoleOverrides);
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
