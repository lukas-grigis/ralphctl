/**
 * Shared TUI test harness. Wraps a rendered view in the same provider stack the production
 * App uses (deps, sessions, prompt-queue, ui-state, hints, selection, router). Individual
 * tests pass stubbed deps and assert on `lastFrame()` or callback invocations.
 *
 * Providers we intentionally keep optional:
 *  - StorageProvider / BusesProvider: only Execute view reads them, so callers opt in.
 *  - PromptQueue: views that use the queued prompt host need it; most don't.
 */

import React from 'react';
import { afterEach } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { tick, waitFor } from '@tests/integration/application/ui/tui/_keys.ts';
import { DepsProvider } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { RouterProvider, type ViewEntry } from '@src/application/ui/tui/runtime/router.tsx';
import { UiStateProvider } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { HintsProvider } from '@src/application/ui/tui/runtime/use-view-hints.tsx';
import { SelectionProvider, useSelection } from '@src/application/ui/tui/runtime/selection-context.tsx';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { SessionsProvider } from '@src/application/ui/tui/runtime/sessions-context.tsx';
import { PromptQueueProvider } from '@src/application/ui/tui/prompts/prompt-context.tsx';
import { StorageProvider } from '@src/application/ui/tui/runtime/storage-context.tsx';
import { BusesProvider, type TuiBuses } from '@src/application/ui/tui/runtime/sinks-context.tsx';
import { SystemStatusProvider } from '@src/application/ui/tui/runtime/system-status-context.tsx';
import { LogLevelProvider } from '@src/application/ui/tui/runtime/log-level-context.tsx';
import { createBusSink } from '@src/application/ui/tui/runtime/sinks-bus.ts';
import { createSessionManager, type SessionManager } from '@src/application/ui/tui/runtime/session-manager.ts';
import { createPromptQueue, type PromptQueue } from '@src/application/ui/tui/prompts/prompt-queue.ts';
import { createLogLevelGate } from '@src/business/observability/log-level-filter.ts';
import type { HarnessSignal } from '@src/domain/signal.ts';
import type { LogEvent } from '@src/business/observability/events.ts';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { StoragePaths } from '@src/application/bootstrap/storage-paths.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';

type RenderResult = ReturnType<typeof render>;

export interface HarnessOptions {
  readonly deps: AppDeps;
  readonly initial: ViewEntry;
  readonly onRoute?: (entry: ViewEntry) => void;
  readonly sessions?: SessionManager;
  readonly queue?: PromptQueue;
  readonly storage?: StoragePaths;
  readonly buses?: TuiBuses;
  /** Pre-stamp the selection context — useful for view tests that assume "current project". */
  readonly selection?: {
    readonly projectId?: ProjectId;
    readonly projectLabel?: string;
    readonly sprintId?: SprintId;
    readonly sprintLabel?: string;
  };
}

export interface HarnessApi {
  readonly result: RenderResult;
  /** Pull every routed view entry that the router has handed to renderView. */
  readonly routeIds: () => readonly string[];
}

const absPath = (p: string): AbsolutePath => {
  const r = AbsolutePath.parse(p);
  if (!r.ok) throw new Error(`harness: invalid path ${p}`);
  return r.value;
};

/**
 * `process.cwd()` is fine for tests — the storage paths only get read by the Doctor probes
 * and a few writers, and tests that exercise either provide their own paths via the deps.
 */
const defaultStorage = (): StoragePaths => {
  const cwd = process.cwd();
  return {
    appRoot: absPath(cwd),
    dataRoot: absPath(cwd),
    configRoot: absPath(cwd),
    stateRoot: absPath(cwd),
    locksRoot: absPath(cwd),
    runsRoot: absPath(cwd),
    memoryRoot: absPath(cwd),
    operatorSkillsRoot: absPath(cwd),
  };
};

export const renderView = (child: React.ReactNode, opts: HarnessOptions): HarnessApi => {
  const sessions = opts.sessions ?? createSessionManager();
  const queue = opts.queue ?? createPromptQueue();
  const storage = opts.storage ?? defaultStorage();
  const buses: TuiBuses = opts.buses ?? {
    harness: createBusSink<HarnessSignal>({ maxEntries: 100 }),
    log: createBusSink<LogEvent>({ maxEntries: 100 }),
  };
  const routes: ViewEntry[] = [];

  const result = render(
    <DepsProvider value={opts.deps}>
      <StorageProvider value={storage}>
        <BusesProvider value={buses}>
          <SessionsProvider value={sessions}>
            <PromptQueueProvider value={queue}>
              <UiStateProvider>
                <HintsProvider>
                  <SelectionProvider>
                    {opts.selection !== undefined && <SeedSelection seed={opts.selection} />}
                    <LogLevelProvider gate={createLogLevelGate('info')}>
                      <SystemStatusProvider>
                        <RouterProvider initial={opts.initial}>
                          {(current): React.ReactNode => {
                            routes.push(current);
                            opts.onRoute?.(current);
                            return child;
                          }}
                        </RouterProvider>
                      </SystemStatusProvider>
                    </LogLevelProvider>
                  </SelectionProvider>
                </HintsProvider>
              </UiStateProvider>
            </PromptQueueProvider>
          </SessionsProvider>
        </BusesProvider>
      </StorageProvider>
    </DepsProvider>
  );

  // Auto-teardown so a failing assertion can never leak the rendered React tree (with its
  // still-firing setIntervals for blinking carets / spinner frames) into the next test in the
  // same file. ink-testing-library keeps a module-level `instances` array that grows forever
  // unless its `cleanup()` is called — `result.unmount()` alone does not drain it. Registering
  // this here, instead of relying on per-test `result.unmount()`, means cleanup runs whether or
  // not the body of the test reached its end.
  afterEach(() => {
    result.unmount();
    cleanup();
  });

  return {
    result,
    routeIds: () => routes.map((r) => r.id),
  };
};

/**
 * Wait until a view has finished its initial async load and its post-mount effects have
 * settled, so a test can safely send input next.
 *
 * Two distinct issues this addresses:
 *
 * 1. **Async hydration race.** Views that hydrate state via async repositories (typically
 *    `findById` / `list` in `useEffect`) show a `<Spinner label="Loading…" />` until the data
 *    resolves; while in that state, their `useInput` handlers short-circuit so any keystroke
 *    sent by a test gets silently dropped. A fixed `tick(N)` after `renderView` races that
 *    load on cold module imports (CI coverage step pays JIT + c8-instrumentation cost on
 *    every import).
 *
 * 2. **Post-commit effect race.** Many views run a follow-up `useEffect` after the first
 *    successful load — e.g. resetting a cursor / focus index, kicking off a derived fetch.
 *    React fires those effects AFTER the commit that flips loading→ok, so the first paint
 *    of the loaded UI happens before they run. Without a trailing settle, a test that
 *    presses a key immediately can have its `setState` overridden by the still-pending
 *    effect.
 *
 * The implementation polls until the frame is non-empty and no longer contains the loading
 * label (handles #1), then yields one extra tick to let post-commit effects flush (handles
 * #2). Pass an optional `extra` predicate to also assert on a specific rendered element
 * before proceeding — useful when "not loading" isn't a strong enough signal.
 *
 * **Use this instead of `tick(N)` immediately after `renderView`.**
 */
export const waitForViewReady = async (
  result: { lastFrame: () => string | undefined },
  extra?: (frame: string) => boolean
): Promise<void> => {
  await waitFor(() => {
    const frame = result.lastFrame() ?? '';
    if (frame.length === 0) return false;
    if (frame.includes('Loading…')) return false;
    return extra ? extra(frame) : true;
  });
  // Flush one tick so any `useEffect` queued by the loading→ok commit (cursor / focus /
  // derived-state syncs) runs before the test sends its first keystroke. Without this the
  // input race described in (2) above resurfaces.
  await tick();
};

/**
 * One-shot effect to seed selection from the harness opts. Lives inside the provider so
 * `useSelection()` resolves; runs once on mount, then renders nothing.
 */
const SeedSelection = ({ seed }: { readonly seed: NonNullable<HarnessOptions['selection']> }): React.JSX.Element => {
  const selection = useSelection();
  // Run once on mount — re-seeding mid-test would fight the view's own selection writes.
  // Pulling the setters into refs lets us keep the dep array literally empty without lint
  // complaining about stale captures.
  const setProjectRef = React.useRef(selection.setProject);
  setProjectRef.current = selection.setProject;
  const setSprintRef = React.useRef(selection.setSprint);
  setSprintRef.current = selection.setSprint;
  React.useEffect(() => {
    if (seed.projectId !== undefined) setProjectRef.current(seed.projectId, seed.projectLabel);
    if (seed.sprintId !== undefined) setSprintRef.current(seed.sprintId, seed.sprintLabel);
  }, [seed]);
  return <></>;
};
