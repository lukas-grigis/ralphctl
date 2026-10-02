/** TUI bootstrap. */

import React from 'react';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { Settings } from '@src/domain/entity/settings.ts';
import type { LogEvent } from '@src/business/observability/events.ts';
import { ensureStorageRoots, resolveStoragePaths } from '@src/application/bootstrap/storage-paths.ts';
import { detectLegacyLayout, renderLegacyLayoutMessage } from '@src/application/bootstrap/legacy-layout-detector.ts';
import { createJsonSettingsRepository } from '@src/integration/persistence/settings/json-settings-repository.ts';
import { type AppDeps, wire } from '@src/application/bootstrap/wire.ts';
import { type BusSink, createBusSink } from '@src/application/ui/tui/runtime/sinks-bus.ts';
import type { SignalBusEntry } from '@src/application/ui/tui/runtime/sinks-context.tsx';
import { type CoalescedBuffer, createCoalescedBuffer } from '@src/application/ui/tui/runtime/coalesced-buffer.ts';
import { createSessionManager, type SessionManager } from '@src/application/ui/tui/runtime/session-manager.ts';
import { createPromptQueue } from '@src/application/ui/tui/prompts/prompt-queue.ts';
import { createInkInteractivePrompt } from '@src/application/ui/tui/prompts/ink-interactive-prompt.ts';
import { createInkHost } from '@src/application/ui/shared/ink-host.ts';
import { setRunInTerminal } from '@src/application/ui/tui/runtime/run-in-terminal.ts';
import { setImplementRoleOverrides } from '@src/application/ui/tui/runtime/implement-role-overrides.ts';
import type { LaunchExtras } from '@src/application/ui/shared/launcher.ts';
import type { ProviderSpawn } from '@src/integration/ai/providers/_engine/spawn.ts';
import { App } from '@src/application/ui/tui/App.tsx';
import { MigrationRoute } from '@src/application/ui/tui/migration/migration-route.tsx';
import {
  createDataMigrationEngine,
  type DataMigrationEngine,
} from '@src/integration/persistence/data-migration/run-data-migration.ts';
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
import { runBundleIntegrityCheck } from '@src/application/bootstrap/run-bundle-integrity-check.ts';

interface Bootstrapped {
  readonly app: Parameters<typeof App>[0];
  readonly drain: () => void;
  /**
   * Pending-migration pre-flight. When `pending` is true, `launchTui` routes the {@link MigrationRoute} consent gate
   * before the App on the initial mount.
   */
  readonly migration: {
    readonly pending: boolean;
    readonly engine: DataMigrationEngine;
    readonly dataRoot: AbsolutePath;
    readonly stateRoot: AbsolutePath;
    readonly now: () => string;
    readonly writeFile: AppDeps['writeFile'];
  };
}

/** Build the EventBus-`log` → logBus forwarder. */
const createLogForwarder = (
  eventBus: AppDeps['eventBus'],
  logBus: BusSink<LogEvent>,
  gate: LogLevelGate
): { readonly buffer: CoalescedBuffer<LogEvent>; readonly unsubscribe: () => void } => {
  const buffer = createCoalescedBuffer<LogEvent>({
    limit: 2000,
    // Delta semantics: a rolling window would re-emit earlier flushes into `logBus` (duplicate lines + heap regrowth).
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
 * Build the EventBus-`ai-signal` → harnessBus forwarder — the harness-signal mirror of {@link createLogForwarder}.
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

/**
 * Wire both observability buses off the composition root's EventBus: build the harness-signal bus + log bus.
 */
const wireObservability = (eventBus: AppDeps['eventBus'], settings: Settings): ObservabilityWiring => {
  // Both buses are populated below by subscribing to the wired EventBus's `'ai-signal'` / `'log'`
  // events — no separate sink is threaded through `wire()`.
  const harnessBus = createBusSink<SignalBusEntry>({ maxEntries: 1000 });
  const logBus = createBusSink<LogEvent>({ maxEntries: 2000 });

  // Forward EventBus 'ai-signal' events into the TUI's harness bus. See createSignalForwarder
  // for the full rationale.
  const unsubSignalForward = createSignalForwarder(eventBus, harnessBus);

  // Forward EventBus 'log' events into the TUI's log bus (coalesced, gate-at-ingest). See createLogForwarder for the
  // full rationale.
  const logLevelGate = createLogLevelGate(settings.logging.level);
  const { buffer: logForwarder, unsubscribe: unsubLogForward } = createLogForwarder(eventBus, logBus, logLevelGate);

  return { harnessBus, logBus, logLevelGate, logForwarder, unsubSignalForward, unsubLogForward };
};

/**
 * Build the heap-watchdog `onWarning` callback — early, non-disruptive relief on entering the 0.80 band.
 */
const createHeapWarningHandler = (args: {
  readonly logger: AppDeps['logger'];
  readonly sessions: SessionManager;
}): (() => void) => {
  const { logger, sessions } = args;
  return () => {
    // Clear the perf-hooks timeline FIRST.
    performance.clearMeasures();
    performance.clearMarks();
    const dropped = sessions.shedTerminal();
    if (dropped > 0) {
      logger.warn(`heap warning — shed ${dropped} finished session record(s) early to relieve pressure`);
    }
  };
};

/**
 * Build the heap-watchdog `onCritical` callback. Captured into its own factory so `bootstrap` stays lean and the
 * post-mortem logic is testable/readable in isolation.
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
    // Defensive buffer-clear: synchronous, fast in-memory ops — run these first so memory is reclaimed immediately
    // (before the snapshot write steals time).
    logForwarder.discard();
    harnessBus.clear();
    logBus.clear();

    // Clear the perf-hooks timeline too: React's dev-reconciler measures are the dominant retainer and live OUTSIDE
    // every app buffer — which is exactly why shedTerminal here historically freed nothing.
    performance.clearMeasures();
    performance.clearMarks();

    // Shed the dominant reachable retainer: drop EVERY terminal SessionRecord (with its trace snapshot).
    const dropped = sessions.shedTerminal();
    if (dropped > 0) {
      logger.warn(`heap critical — shed ${dropped} finished session record(s) for memory relief`);
    } else {
      logger.warn(
        'heap critical — no terminal records to shed; cleared the perf-hooks timeline (React dev-reconciler measures), the dominant retainer that lives outside app buffers'
      );
    }

    // Heap snapshot deferred off the hot path via setImmediate. v8.writeHeapSnapshot() is a synchronous V8 operation
    // that blocks the Node.js event loop for several seconds on large heaps.
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
 * Bound Node's process-global performance timeline. Safe only while nothing reads marks / measures back and React
 * emits numeric `{start,end}` measures — re-audit on a React upgrade.
 */
const startPerfTimelineGuard = (): { readonly stop: () => void } => {
  const handle = setInterval(() => {
    performance.clearMeasures();
    performance.clearMarks();
  }, 10_000);
  handle.unref?.();
  return { stop: (): void => clearInterval(handle) };
};

/** Wire OS-attention notifications. */
const wireOsNotifications = (deps: AppDeps, settings: Settings): (() => void) => {
  const osNotificationDispatcher = createOsNotificationDispatcher({ logger: deps.logger });
  return startNotificationSubscriber({
    eventBus: deps.eventBus,
    dispatcher: osNotificationDispatcher,
    disabled: () => settings.ui.notifications.enabled === false,
  });
};

/**
 * Resolve the launch-time view state — first-run detection lives in launch-routing.ts as a pure function.
 */
const resolveLaunchViewState = async (
  deps: AppDeps,
  stateRoot: AbsolutePath
): Promise<InitialState & { readonly lastSelectionStore: LastSelectionStore }> => {
  const settingsExists = await deps.settingsRepo.exists();
  const projectsList = await deps.projectRepo.list();
  const sprintsResult = await deps.sprintRepo.list();
  const lastSelectionStore = createLastSelectionStore(stateRoot);
  const lastSelection = await lastSelectionStore.read();
  const initialState = resolveInitialState({
    settingsExist: settingsExists.ok ? settingsExists.value : false,
    projects: projectsList.ok ? projectsList.value : [],
    sprints: sprintsResult.ok ? sprintsResult.value : [],
    ...(lastSelection !== undefined ? { lastProjectId: lastSelection.projectId } : {}),
    ...(lastSelection?.sprintId !== undefined ? { lastSprintId: lastSelection.sprintId } : {}),
  });
  return { ...initialState, lastSelectionStore };
};

const runBootChecks = async (deps: AppDeps): Promise<void> => {
  await runBundleIntegrityCheck(deps.logger);
  // Fallback for the orphan reaper: kill AI CLI process groups that a crashed earlier run left alive.
  void deps.reapInterruptedRuns.execute();
};

const bootstrap = async (options: LaunchTuiOptions = {}): Promise<Bootstrapped> => {
  const paths = resolveStoragePaths();
  if (!paths.ok) throw new Error(`storage-paths: ${paths.error.message}`);

  // Legacy-layout check runs BEFORE ensureStorageRoots and BEFORE the Ink mount so the user sees the recovery message
  // on the regular terminal (alt-screen hasn't engaged yet).
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

  const deps = wire({
    storage: paths.value,
    settings: settings.value,
    ...(options.providerSpawn !== undefined ? { providerSpawn: options.providerSpawn } : {}),
  });

  // Runs once per process: `launchTui` is the single bare-`ralphctl` entry point and `bootstrap` runs exactly once
  // per invocation.
  await runBootChecks(deps);

  const { harnessBus, logBus, logLevelGate, logForwarder, unsubSignalForward, unsubLogForward } = wireObservability(
    deps.eventBus,
    settings.value
  );

  // Session manager is created BEFORE the heap watchdog so the critical handler can reach it to
  // shed finished SessionRecords (the dominant app-root-reachable retainer) under memory pressure.
  const sessions = createSessionManager({ runs: deps.inProcessRuns });

  // Heap watchdog gives the operator a warning before V8 SIGKILLs the harness on a long-running session.
  const heapWatchdog = startHeapWatchdog({
    eventBus: deps.eventBus,
    onWarning: createHeapWarningHandler({ logger: deps.logger, sessions }),
    onCritical: createHeapCriticalHandler({ logger: deps.logger, logForwarder, harnessBus, logBus, sessions }),
  });

  // Bound Node's perf-hooks timeline.
  const perfTimelineGuard = startPerfTimelineGuard();

  const unsubNotifications = wireOsNotifications(deps, settings.value);

  const queue = createPromptQueue();

  // The Ink prompt adapter is plumbed through deps that the launcher reads; chain factories
  // that need an `InteractivePrompt` (create-sprint, readiness) get this
  // adapter via the launcher.
  void createInkInteractivePrompt(queue);

  const { initialView, initialSelection, lastSelectionStore } = await resolveLaunchViewState(
    deps,
    paths.value.stateRoot
  );

  // Pending-migration pre-flight. Runs AFTER ensureStorageRoots, BEFORE the App mount.
  const migrationEngine = createDataMigrationEngine();
  const migrationPending = await migrationEngine.needsMigration(paths.value.dataRoot);

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
      unsubSignalForward();
      unsubLogForward();
      logForwarder.stop();
      heapWatchdog.stop();
      perfTimelineGuard.stop();
      unsubNotifications();
    },
    migration: {
      pending: migrationPending,
      engine: migrationEngine,
      dataRoot: paths.value.dataRoot,
      stateRoot: paths.value.stateRoot,
      now: () => String(deps.clock()),
      writeFile: deps.writeFile,
    },
  };
};

/**
 * Decide whether the initial Ink mount routes the {@link MigrationRoute} consent gate (vs. the App directly).
 * @public
 */
export const shouldShowMigrationGate = (pending: boolean, gateResolved: boolean): boolean => pending && !gateResolved;

export interface LaunchTuiOptions {
  /**
   * Per-launch overrides for `settings.ai.implement` — parsed from the bare-`ralphctl`
   * `--implement-{generator,evaluator}-{provider,model}` flags.
   */
  readonly implementRoleOverrides?: LaunchExtras['implementRoleOverrides'];
  /** Replaces the AI adapters' `node:child_process.spawn`. */
  readonly providerSpawn?: ProviderSpawn;
}

export const launchTui = async (options: LaunchTuiOptions = {}): Promise<void> => {
  // TTY pre-flight.
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
    booted = await bootstrap(options);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`ralphctl: failed to start TUI — ${msg}\n`);
    process.exitCode = 1;
    return;
  }

  // Live in-memory holder for the current selection, seeded from the launch-time persisted value.
  let liveSelection = booted.app.initialSelection;
  const onSelectionChange = (next: SelectionSeed): void => {
    liveSelection = next;
    booted.app.onSelectionChange?.(next);
  };

  // Migration consent gate. Routed ONLY on the initial mount while a migration is pending and has not yet resolved.
  let gateResolved = false;
  const appProps = (): Parameters<typeof App>[0] => ({
    ...booted.app,
    onSelectionChange,
    ...(liveSelection !== undefined ? { initialSelection: liveSelection } : {}),
  });
  const renderElement = (): React.ReactElement => {
    if (shouldShowMigrationGate(booted.migration.pending, gateResolved)) {
      return React.createElement(MigrationRoute, {
        gate: {
          engine: booted.migration.engine,
          dataRoot: booted.migration.dataRoot,
          stateRoot: booted.migration.stateRoot,
          appVersion: CLI_METADATA.currentVersion,
          now: booted.migration.now,
          writeFile: booted.migration.writeFile,
        },
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
