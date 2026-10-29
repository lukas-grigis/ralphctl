/**
 * TUI bootstrap: resolves storage paths, loads settings, builds the harness-signal and log buses
 * (fed from the EventBus's `'ai-signal'` / `'log'` events), wires deps and renders App. Pre-render
 * errors become a one-line stderr message + non-zero exit instead of a blank Ink frame. Doctor
 * probes are not run here — `HomeView` re-runs them on every mount.
 */

import React from 'react';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { Settings } from '@src/domain/entity/settings.ts';
import type { LogEvent } from '@src/business/observability/events.ts';
import { bootstrapApp } from '@src/application/bootstrap/bootstrap-app.ts';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import { type BusSink, createBusSink } from '@src/application/ui/tui/runtime/sinks-bus.ts';
import type { SignalBusEntry } from '@src/application/ui/tui/runtime/sinks-context.tsx';
import { type CoalescedBuffer, createCoalescedBuffer } from '@src/application/ui/tui/runtime/coalesced-buffer.ts';
import { createSessionManager, type SessionManager } from '@src/application/ui/tui/runtime/session-manager.ts';
import { createPromptQueue } from '@src/application/ui/tui/prompts/prompt-queue.ts';
import { createInkHost } from '@src/application/ui/shared/ink-host.ts';
import { setRunInTerminal } from '@src/application/ui/tui/runtime/run-in-terminal.ts';
import { setImplementRoleOverrides } from '@src/application/ui/tui/runtime/implement-role-overrides.ts';
import type { LaunchExtras } from '@src/application/ui/shared/launcher.ts';
import type { ProviderSpawn } from '@src/integration/ai/providers/_engine/spawn.ts';
import { App } from '@src/application/ui/tui/App.tsx';
import { MigrationRoute } from '@src/application/ui/tui/migration/migration-route.tsx';
import { createDataMigrationEngine } from '@src/integration/persistence/data-migration/run-data-migration.ts';
import { CLI_METADATA } from '@src/business/version/cli-metadata.ts';
import type { SelectionSeed } from '@src/application/ui/tui/runtime/selection-context.tsx';
import { type InitialState, resolveInitialState } from '@src/application/ui/tui/launch-routing.ts';
import {
  createLastSelectionStore,
  type LastSelectionStore,
} from '@src/integration/persistence/selection/last-selection-store.ts';
import { type LogLevelGate, createLogLevelGate, passesLogLevel } from '@src/business/observability/log-level-filter.ts';
import { startHeapWatchdog } from '@src/integration/observability/heap-watchdog.ts';
import { writeHeapSnapshotToDir } from '@src/integration/observability/heap-snapshot.ts';
import { createOsNotificationDispatcher } from '@src/integration/observability/os-notification-dispatcher.ts';
import { startNotificationSubscriber } from '@src/business/observability/notification-subscriber.ts';

interface Bootstrapped {
  readonly app: Parameters<typeof App>[0];
  readonly drain: () => void;
  /** When `pending`, the initial mount routes the {@link MigrationRoute} consent gate before the App. */
  readonly migration: {
    readonly pending: boolean;
    readonly gate: Parameters<typeof MigrationRoute>[0]['gate'];
  };
}

/**
 * EventBus-`log` → logBus forwarder, and the UI-floor chokepoint: the log-level gate is applied
 * HERE, at ingest, against the live gate (providers publish every stream-json line verbatim; the
 * events.ndjson sink writes them regardless of floor).
 *
 * Admitted events go through a CoalescedBuffer (at most ~16fps; each flush emits its batch in one
 * synchronous turn): one `logBus.emit` per line at a DEBUG floor drove one React commit per line,
 * i.e. unthrottled Yoga layout and OOM. Returns the buffer (`flushNow` / `stop`) and the
 * unsubscribe, so a re-launched TUI in the same process does not double-publish.
 */
const createLogForwarder = (
  eventBus: AppDeps['eventBus'],
  logBus: BusSink<LogEvent>,
  gate: LogLevelGate
): { readonly buffer: CoalescedBuffer<LogEvent>; readonly unsubscribe: () => void } => {
  const buffer = createCoalescedBuffer<LogEvent>({
    limit: 2000,
    // Delta semantics: a rolling window would re-emit prior-flush events every tick and re-grow the bus.
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
 * EventBus-`ai-signal` → harnessBus forwarder. Unlike the log forwarder it does not coalesce:
 * per-task signal volume (~20-40) is orders of magnitude below a DEBUG log stream. Returns the
 * unsubscribe.
 */
const createSignalForwarder = (eventBus: AppDeps['eventBus'], harnessBus: BusSink<SignalBusEntry>): (() => void) =>
  eventBus.subscribe((event) => {
    if (event.type !== 'ai-signal') return;
    harnessBus.emit({
      signal: event.signal,
      source: event.source,
      ...(event.taskId !== undefined ? { taskId: event.taskId } : {}),
    });
  });

interface ObservabilityWiring {
  readonly harnessBus: BusSink<SignalBusEntry>;
  readonly logBus: BusSink<LogEvent>;
  readonly logLevelGate: LogLevelGate;
  readonly logForwarder: CoalescedBuffer<LogEvent>;
  readonly unsubSignalForward: () => void;
  readonly unsubLogForward: () => void;
}

/** Wire both observability buses off the EventBus: `'ai-signal'` → harness bus, `'log'` → log bus through the level gate. */
const wireObservability = (eventBus: AppDeps['eventBus'], settings: Settings): ObservabilityWiring => {
  const harnessBus = createBusSink<SignalBusEntry>({ maxEntries: 1000 });
  const logBus = createBusSink<LogEvent>({ maxEntries: 2000 });

  const unsubSignalForward = createSignalForwarder(eventBus, harnessBus);

  // The gate is a mutable holder seeded from `settings.logging.level`; the Settings view swaps the
  // floor via `gate.set(...)` and the forwarder reads it per event.
  const logLevelGate = createLogLevelGate(settings.logging.level);
  const { buffer: logForwarder, unsubscribe: unsubLogForward } = createLogForwarder(eventBus, logBus, logLevelGate);

  return { harnessBus, logBus, logLevelGate, logForwarder, unsubSignalForward, unsubLogForward };
};

/**
 * Heap-watchdog `onWarning` (0.80 band): early, non-disruptive relief — clear the perf timeline
 * ({@link startPerfTimelineGuard}) and shed finished SessionRecords. Keeps the log panel and writes
 * no snapshot. Must never throw.
 */
const createHeapWarningHandler = (args: {
  readonly logger: AppDeps['logger'];
  readonly sessions: SessionManager;
}): (() => void) => {
  const { logger, sessions } = args;
  return () => {
    performance.clearMeasures();
    performance.clearMarks();
    const dropped = sessions.shedTerminal();
    if (dropped > 0) {
      logger.warn(`heap warning — shed ${dropped} finished session record(s) early to relieve pressure`);
    }
  };
};

/**
 * Heap-watchdog `onCritical`: drop the buffers, clear the perf timeline, shed every terminal
 * SessionRecord (never a running one), then write a heap snapshot — the real diagnostic, naming
 * the dominant retainer. Must never throw.
 */
const createHeapCriticalHandler = (args: {
  readonly logger: AppDeps['logger'];
  readonly logForwarder: CoalescedBuffer<LogEvent>;
  readonly harnessBus: BusSink<SignalBusEntry>;
  readonly logBus: BusSink<LogEvent>;
  readonly sessions: SessionManager;
}): (() => void) => {
  const { logger, logForwarder, harnessBus, logBus, sessions } = args;
  return () => {
    // Buffer-clear first, so memory is reclaimed before the snapshot write; discard (not flush) the pending batch.
    logForwarder.discard();
    harnessBus.clear();
    logBus.clear();

    performance.clearMeasures();
    performance.clearMarks();

    const dropped = sessions.shedTerminal();
    if (dropped > 0) {
      logger.warn(`heap critical — shed ${dropped} finished session record(s) for memory relief`);
    } else {
      logger.warn(
        'heap critical — no terminal records to shed; cleared the perf-hooks timeline (React dev-reconciler measures), the dominant retainer that lives outside app buffers'
      );
    }

    // Deferred one tick: the synchronous v8 snapshot blocks the event loop for seconds on large heaps.
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

/**
 * Bound Node's process-global performance timeline. React 19's DEVELOPMENT reconciler writes a
 * `performance.measure()` per committed fiber and `perf_hooks` retains every entry, so a multi-hour
 * run OOMs from OUTSIDE every app buffer (`shedTerminal` cannot reach it). Nothing in this process
 * consumes marks/measures, so the whole timeline is dropped on a fixed cadence; the heap-watchdog
 * handlers also clear it under pressure. A silent no-op in a production React build.
 *
 * Safe against React's reconciler: it builds every measure from numeric `{ start, end }` options
 * (never a named start-mark) and never reads the timeline back. INVARIANT: the clear is
 * process-global — re-audit if a dependency starts referencing named marks or anything starts
 * consuming them. Unref'd so it never keeps the process alive.
 */
const startPerfTimelineGuard = (): { readonly stop: () => void } => {
  const handle = setInterval(() => {
    performance.clearMeasures();
    performance.clearMarks();
  }, 10_000);
  handle.unref?.();
  return { stop: (): void => clearInterval(handle) };
};

/**
 * OS-attention notifications. Kept out of `wire()` so tests never pop real notifications; the gate
 * reads the boot-time settings (a runtime toggle requires relaunch).
 */
const wireOsNotifications = (deps: AppDeps, settings: Settings): (() => void) => {
  const osNotificationDispatcher = createOsNotificationDispatcher({ logger: deps.logger });
  return startNotificationSubscriber({
    eventBus: deps.eventBus,
    dispatcher: osNotificationDispatcher,
    disabled: () => settings.ui.notifications.enabled === false,
  });
};

/** Resolve the side-effecting inputs of the pure first-run routing (`launch-routing.ts`). */
const resolveLaunchViewState = async (
  deps: AppDeps,
  stateRoot: AbsolutePath
): Promise<InitialState & { readonly lastSelectionStore: LastSelectionStore }> => {
  const lastSelectionStore = createLastSelectionStore(stateRoot);
  const [settingsExists, projectsList, sprintsResult, lastSelection] = await Promise.all([
    deps.settingsRepo.exists(),
    deps.projectRepo.list(),
    deps.sprintRepo.list(),
    lastSelectionStore.read(),
  ]);
  const initialState = resolveInitialState({
    settingsExist: settingsExists.ok ? settingsExists.value : false,
    projects: projectsList.ok ? projectsList.value : [],
    sprints: sprintsResult.ok ? sprintsResult.value : [],
    ...(lastSelection !== undefined ? { lastProjectId: lastSelection.projectId } : {}),
    ...(lastSelection?.sprintId !== undefined ? { lastSprintId: lastSelection.sprintId } : {}),
  });
  return { ...initialState, lastSelectionStore };
};

const bootstrap = async (options: LaunchTuiOptions = {}): Promise<Bootstrapped> => {
  // Runs BEFORE the Ink mount so legacy-layout recovery messages land on the regular terminal; a hard
  // failure throws and `launchTui` prints it as one stderr line.
  const { deps, storage } = await bootstrapApp(
    options.providerSpawn !== undefined ? { providerSpawn: options.providerSpawn } : {}
  );
  const settings = deps.settings;
  // Fallback for the orphan reaper: kill AI CLI process groups that a crashed earlier run left alive.
  void deps.reapInterruptedRuns.execute();

  const { harnessBus, logBus, logLevelGate, logForwarder, unsubSignalForward, unsubLogForward } = wireObservability(
    deps.eventBus,
    settings
  );

  // Created before the heap watchdog so its handlers can shed finished SessionRecords.
  const sessions = createSessionManager({ runs: deps.inProcessRuns });

  // Two-tier relief before V8 kills a long session: 'warning' (0.80) sheds early and non-disruptively;
  // 'critical' also clears buffers and captures a heap snapshot for post-mortem.
  const heapWatchdog = startHeapWatchdog({
    eventBus: deps.eventBus,
    onWarning: createHeapWarningHandler({ logger: deps.logger, sessions }),
    onCritical: createHeapCriticalHandler({ logger: deps.logger, logForwarder, harnessBus, logBus, sessions }),
  });

  const perfTimelineGuard = startPerfTimelineGuard();

  const unsubNotifications = wireOsNotifications(deps, settings);

  const queue = createPromptQueue();

  const { initialView, initialSelection, lastSelectionStore } = await resolveLaunchViewState(deps, storage.stateRoot);

  // Pending-migration pre-flight (marker file absent ⇒ pending); the TUI owns consent, the headless CLI skips migration.
  const migrationEngine = createDataMigrationEngine();
  const migrationPending = await migrationEngine.needsMigration(storage.dataRoot);

  return {
    app: {
      deps,
      storage,
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
      unsubSignalForward();
      unsubLogForward();
      logForwarder.stop();
      heapWatchdog.stop();
      perfTimelineGuard.stop();
      unsubNotifications();
    },
    migration: {
      pending: migrationPending,
      gate: {
        engine: migrationEngine,
        dataRoot: storage.dataRoot,
        stateRoot: storage.stateRoot,
        appVersion: CLI_METADATA.currentVersion,
        now: () => String(deps.clock()),
        writeFile: deps.writeFile,
      },
    },
  };
};

export interface LaunchTuiOptions {
  /** Per-launch `settings.ai.implement` overrides from the bare-`ralphctl` flags, read by `flows-view` via a module-level holder reset on every launch. */
  readonly implementRoleOverrides?: LaunchExtras['implementRoleOverrides'];
  /**
   * Replaces the AI adapters' `spawn` (carried on `AppDeps.providerSpawn` so it survives per-launch
   * adapter rebuilds; git / gh still spawn for real). Sole producer: `ralphctl demo --script`.
   */
  readonly providerSpawn?: ProviderSpawn;
}

export const launchTui = async (options: LaunchTuiOptions = {}): Promise<void> => {
  // TTY pre-flight: on a non-TTY stdin Ink's raw-mode failure surfaces post-mount as ~2KB of reconciler
  // frames and exit 0. The named exception to "mount is unconditional" in CLAUDE.md.
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(
      'ralphctl: the interactive TUI requires a terminal — run inside a TTY, ' +
        'or use a subcommand (ralphctl --help) for non-interactive use\n'
    );
    process.exitCode = 1;
    return;
  }

  setImplementRoleOverrides(options.implementRoleOverrides);
  let booted: Bootstrapped;
  try {
    booted = await bootstrap(options);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`ralphctl: failed to start TUI — ${msg}\n`);
    process.exitCode = 1;
    return;
  }

  // Each interactive-flow pause remounts the tree; SelectionProvider re-seeds from this holder so an
  // in-session sprint switch survives instead of snapping back to the launch-time selection.
  let liveSelection = booted.app.initialSelection;
  const onSelectionChange = (next: SelectionSeed): void => {
    liveSelection = next;
    booted.app.onSelectionChange?.(next);
  };

  // `gateResolved` lives in the launch closure (React state is lost on the pause/resume remount) so a
  // mid-session AI pause never re-shows the consent screen.
  let gateResolved = false;
  const appProps = (): Parameters<typeof App>[0] => ({
    ...booted.app,
    onSelectionChange,
    ...(liveSelection !== undefined ? { initialSelection: liveSelection } : {}),
  });
  const renderElement = (): React.ReactElement => {
    if (booted.migration.pending && !gateResolved) {
      return React.createElement(MigrationRoute, {
        gate: booted.migration.gate,
        app: appProps(),
        onResolved: (): void => {
          gateResolved = true;
        },
      });
    }
    return React.createElement(App, appProps());
  };
  const host = createInkHost({ renderElement });
  setRunInTerminal(host.runInTerminal);
  try {
    await host.waitForShutdown();
  } finally {
    // Land pending live-run record removals before exit, or the next launch reads a false interruption.
    await booted.app.deps.inProcessRuns.flush();
    booted.drain();
  }
};
