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
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
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
import { createSessionManager, type SessionManager } from '@src/application/ui/tui/runtime/session-manager.ts';
import { createPromptQueue } from '@src/application/ui/tui/prompts/prompt-queue.ts';
import { createInkInteractivePrompt } from '@src/application/ui/tui/prompts/ink-interactive-prompt.ts';
import { createInkHost } from '@src/application/ui/shared/ink-host.ts';
import { setRunInTerminal } from '@src/application/ui/tui/runtime/run-in-terminal.ts';
import { setImplementRoleOverrides } from '@src/application/ui/tui/runtime/implement-role-overrides.ts';
import type { LaunchExtras } from '@src/application/ui/shared/launcher.ts';
import { App } from '@src/application/ui/tui/App.tsx';
import { MigrationRoute } from '@src/application/ui/tui/migration/migration-route.tsx';
import {
  createDataMigrationEngine,
  type DataMigrationEngine,
} from '@src/integration/persistence/data-migration/run-data-migration.ts';
import { CLI_METADATA } from '@src/business/version/cli-metadata.ts';
import type { SelectionSeed } from '@src/application/ui/tui/runtime/selection-context.tsx';
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
  /**
   * Pending-migration pre-flight. When `pending` is true, `launchTui` routes the
   * {@link MigrationRoute} consent gate before the App on the initial mount. Absent (`pending`
   * false) ⇒ the App mounts directly. The engine + ctx ingredients are carried so the render thunk
   * can build the gate without re-resolving them.
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
 * Build the heap-watchdog `onWarning` callback — early, non-disruptive relief on entering the
 * 0.80 band. Sheds finished SessionRecords (the dominant app-root-reachable retainer) so GC
 * reclaims headroom BEFORE pressure reaches critical. Unlike the critical handler it does NOT
 * clear the live log/harness buffers (the operator keeps their log panel) and writes no heap
 * snapshot (no event-loop stall). `shedTerminal` never touches a running record. Must never throw.
 */
const createHeapWarningHandler = (args: {
  readonly logger: AppDeps['logger'];
  readonly sessions: SessionManager;
}): (() => void) => {
  const { logger, sessions } = args;
  return () => {
    // Clear the perf-hooks timeline FIRST. React's dev-reconciler per-fiber measures are the
    // dominant retainer, and they live outside every app buffer — `shedTerminal` below cannot
    // reach them. Clearing here makes 0.80-band relief drop the real weight, not just finished
    // records. Safe: React never reads its own measures back. See startPerfTimelineGuard.
    performance.clearMeasures();
    performance.clearMarks();
    const dropped = sessions.shedTerminal();
    if (dropped > 0) {
      logger.warn(`heap warning — shed ${dropped} finished session record(s) early to relieve pressure`);
    }
  };
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
  readonly sessions: SessionManager;
}): (() => void) => {
  const { logger, logForwarder, harnessBus, logBus, sessions } = args;
  return () => {
    // Defensive buffer-clear: synchronous, fast in-memory ops — run these first so memory is
    // reclaimed immediately (before the snapshot write steals time). Drop (do NOT flush) the
    // batch the forwarder is holding; flushing would re-emit into `logBus` immediately before
    // we empty it — pointless churn. discard() empties the window without emitting.
    logForwarder.discard();
    harnessBus.clear();
    logBus.clear();

    // Clear the perf-hooks timeline too: React's dev-reconciler measures are the dominant retainer
    // and live OUTSIDE every app buffer — which is exactly why shedTerminal here historically freed
    // nothing. Safe: React never reads its own measures back. See startPerfTimelineGuard.
    performance.clearMeasures();
    performance.clearMarks();

    // Shed the dominant reachable retainer: drop EVERY terminal SessionRecord (with its trace
    // snapshot). The small-capped buffers above free little; completed/aborted/failed run records
    // accumulated across a long session are the real weight the app root can reach. shedTerminal
    // never touches a running record, so a healthy in-flight run is never disturbed — this only
    // sheds memory from work that is already done.
    const dropped = sessions.shedTerminal();
    if (dropped > 0) {
      logger.warn(`heap critical — shed ${dropped} finished session record(s) for memory relief`);
    } else {
      logger.warn(
        'heap critical — no terminal records to shed; cleared the perf-hooks timeline (React dev-reconciler measures), the dominant retainer that lives outside app buffers'
      );
    }

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

/**
 * Bound Node's process-global performance timeline. React 19's DEVELOPMENT reconciler writes a
 * `performance.measure()` per committed fiber on every commit (the changed-props diff is attached
 * as the measure's `detail`), and Node's `perf_hooks` retains every entry unbounded. A multi-hour
 * TUI run commits constantly, so the timeline grows without bound and OOMs from OUTSIDE every app
 * buffer — the heap watchdog's `shedTerminal` structurally cannot reach it. Nothing in this process
 * consumes marks/measures (the app + Ink only ever call `performance.now()`), so we drop the whole
 * timeline on a fixed cadence. Under a production React build this is a silent no-op (the reconciler
 * emits nothing), so it is safe to install unconditionally.
 *
 * Throw-safety (timing-independent): `clearMeasures()` / `clearMarks()` can never make React's
 * `performance.measure` throw, because React 19.2's reconciler builds every measure from a numeric
 * `{ start, end }` options object — never a named start-mark — and never reads the timeline back
 * (zero `getEntries*` calls). So a clear can neither split a mark→measure pair nor perturb
 * reconciliation, however it interleaves with a commit. Unref'd so it never keeps the process
 * alive; `clear*` are cheap in-memory splices.
 *
 * INVARIANT: this clear is process-global. If a future dependency ever emits a `performance.measure`
 * that references a NAMED start mark (not numeric `{ start, end }` options), or any TUI-process
 * feature ever CONSUMES marks/measures, re-audit before assuming this guard stays safe.
 */
const startPerfTimelineGuard = (): { readonly stop: () => void } => {
  const handle = setInterval(() => {
    performance.clearMeasures();
    performance.clearMarks();
  }, 10_000);
  handle.unref?.();
  return { stop: (): void => clearInterval(handle) };
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

  // Session manager is created BEFORE the heap watchdog so the critical handler can reach it to
  // shed finished SessionRecords (the dominant app-root-reachable retainer) under memory pressure.
  const sessions = createSessionManager();

  // Heap watchdog gives the operator a warning before V8 SIGKILLs the harness on a long-running
  // session. Two-tier relief: on 'warning' (0.80) it sheds finished session records EARLY and
  // non-disruptively (no buffer clear, no snapshot) so GC reclaims headroom before pressure peaks;
  // on 'critical' it sheds again, clears the small-capped in-memory buffers, and captures a heap
  // snapshot for post-mortem (names the dominant retainer if the shed was not enough). The session
  // shed + snapshot are the load-bearing actions; the buffer clear is defensive.
  const heapWatchdog = startHeapWatchdog({
    eventBus: deps.eventBus,
    onWarning: createHeapWarningHandler({ logger: deps.logger, sessions }),
    onCritical: createHeapCriticalHandler({ logger: deps.logger, logForwarder, harnessBus, logBus, sessions }),
  });

  // Bound Node's perf-hooks timeline. React's dev reconciler writes a performance.measure per fiber
  // per commit, retained unbounded by Node — a leak OUTSIDE every app buffer that the heap watchdog
  // structurally cannot shed. The periodic guard drops it on a cadence; the watchdog handlers above
  // also clear it the moment real pressure fires. No-op under a production React build.
  const perfTimelineGuard = startPerfTimelineGuard();

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

  // Pending-migration pre-flight. Runs AFTER ensureStorageRoots, BEFORE the App mount. The engine
  // is a pure factory; `needsMigration` only reads the marker file (absent ⇒ pending). When pending,
  // launchTui routes the consent gate first. The TUI is already TTY-gated at the top of launchTui, so
  // this is always interactive — no separate non-TTY branch is needed here (the CLI bootstrap, which
  // CAN run headless, deliberately skips migration entirely; the TUI owns consent).
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
 * Decide whether the initial Ink mount routes the {@link MigrationRoute} consent gate (vs. the App
 * directly). The gate shows ONLY when a migration is pending AND it has not already resolved this
 * session — once resolved, a later pause/resume remount renders the App directly so an AI-session
 * pause never re-shows the consent screen. Pure so the launch wiring is unit-testable without a
 * full bootstrap.
 *
 * @public
 */
export const shouldShowMigrationGate = (pending: boolean, gateResolved: boolean): boolean => pending && !gateResolved;

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

  // Live in-memory holder for the current selection, seeded from the launch-time persisted value.
  // Each interactive-flow pause unmounts the React tree and remounts it via `renderElement()`;
  // SelectionProvider re-seeds from this holder, so an in-session sprint switch survives the
  // remount instead of snapping back to the stale launch-time `initialSelection`.
  let liveSelection = booted.app.initialSelection;
  const onSelectionChange = (next: SelectionSeed): void => {
    liveSelection = next;
    booted.app.onSelectionChange?.(next);
  };

  // Migration consent gate. Routed ONLY on the initial mount while a migration is pending and has
  // not yet resolved. `gateResolved` is a launch-closure flag (not React state, which is lost on the
  // pause/resume remount): once the gate resolves, every later remount renders the App directly so a
  // mid-session AI-session pause never re-shows the consent screen.
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
    booted.drain();
  }
};
