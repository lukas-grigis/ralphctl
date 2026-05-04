/**
 * E2E harness for the Ink TUI.
 *
 * Boots `<App />` directly via `ink-testing-library` against a fully wired
 * SharedDeps graph — same one production uses, with two surgical
 * substitutions:
 *
 *   - `aiSession` is a `FakeAiSessionPort` returning scripted outputs, and
 *     `signalParser` returns scripted `HarnessSignal[]` lists. Together
 *     they replace the non-deterministic AI provider with a timeline the
 *     test author owns.
 *   - `external` is a `FakeExternalPort` (no real git). Default config:
 *     clean working tree, branch verification ok, check scripts pass.
 *
 * Everything else is real:
 *   - `SessionManager` (the real in-memory implementation, not the fake)
 *   - `InMemorySignalBus` + `RateLimitCoordinator`
 *   - `Sequential` / `Leaf` / `Retry` / `OnError` from the kernel
 *   - The chain factories (`createExecuteFlow`, etc.) and every leaf inside
 *
 * The harness pre-launches the chain via `sessionManager.start(...)` BEFORE
 * rendering, so the ExecuteView attaches to a live runner the same way it
 * would in production. Tests assert on rendered frames via `vi.waitFor`
 * and on persisted state via the in-memory repos exposed on `deps`.
 *
 * Cleanup is automatic via `afterEach` — every harness instance unmounts
 * its Ink tree, disposes its session manager, and resets shared deps.
 */
import React from 'react';
import { afterEach, vi } from 'vitest';
import { render } from 'ink-testing-library';

import { App } from '@src/application/tui/views/app.tsx';
import { setSharedDeps, resetSharedDeps } from '@src/application/bootstrap/get-shared-deps.ts';
import { SessionManager } from '@src/application/runtime/session-manager.ts';
import type { SessionId } from '@src/application/runtime/session-manager-port.ts';
import { buildTuiDeps, type TuiDepsOptions, type TuiTestDeps } from '@src/application/_test-fakes/build-tui-deps.ts';
import { createExecuteFlow, type ExecuteCtx } from '@src/application/chains/execute/execute-flow.ts';
import type { Sprint } from '@src/domain/entities/sprint.ts';
import type { Task } from '@src/domain/entities/task.ts';
import type { AbsolutePath } from '@src/domain/values/absolute-path.ts';

type InkRenderResult = ReturnType<typeof render>;

/**
 * Real-SessionManager-backed test deps. Same shape as `TuiTestDeps` but
 * `sessionManager` is the production `SessionManager` (not a fake), so
 * chains actually run end-to-end.
 */
export interface E2eDeps extends Omit<TuiTestDeps, 'sessionManager'> {
  readonly sessionManager: SessionManager;
}

export interface E2eHarness extends InkRenderResult {
  readonly deps: E2eDeps;
  /** Session id of the chain that was pre-launched before render. */
  readonly sessionId: SessionId;
  /**
   * Wait for the live frame to satisfy `matcher`. Polls via `vi.waitFor`
   * with a generous default timeout — chain step settlements involve
   * microtask + Ink reconciliation cycles.
   */
  readonly waitForFrame: (matcher: string | RegExp, opts?: { timeout?: number }) => Promise<void>;
  /**
   * Wait for the runner to reach a terminal state (completed / failed /
   * aborted). Resolves with the terminal status.
   */
  readonly waitForTerminal: (opts?: { timeout?: number }) => Promise<'completed' | 'failed' | 'aborted'>;
}

/**
 * Options for `bootExecuteScenario`. The TuiDepsOptions super-type owns
 * the `aiSession` / `signalParser` / `external` / `prompt` overrides plus
 * the `evaluationIterations` knob — pass them through verbatim.
 */
export interface BootExecuteScenarioOpts extends Omit<TuiDepsOptions, 'sprints' | 'tasks'> {
  /** Sprint to execute. Must be active and have a branch set. */
  readonly sprint: Sprint;
  /** Tasks belonging to the sprint. */
  readonly sprintTasks: readonly Task[];
  /** Working directory passed to the execute flow. */
  readonly cwd: AbsolutePath;
  /**
   * Pre-resolved branch name. `''` means "keep current branch" (no
   * branch verification per task). Defaults to `sprint.branch ?? ''`.
   */
  readonly expectedBranch?: string;
}

let activeHarness: E2eHarness | null = null;

afterEach(async () => {
  if (activeHarness) {
    activeHarness.unmount();
    await activeHarness.deps.sessionManager.dispose();
    activeHarness = null;
  }
  resetSharedDeps();
  vi.restoreAllMocks();
});

let idCounter = 0;
function nextSessionId(): SessionId {
  idCounter += 1;
  return `e2e-${String(idCounter)}`;
}

/**
 * Boot the full Ink app rooted at the ExecuteView, with the executeFlow
 * pre-launched against a scripted AI timeline. The view attaches to the
 * live runner immediately on mount.
 */
export function bootExecuteScenario(opts: BootExecuteScenarioOpts): E2eHarness {
  // 1. Build the shared deps graph — `buildTuiDeps` wires the in-memory
  //    repositories, fake AI / external / prompt ports, real signal bus +
  //    parser, real rate-limit coordinator. We override `sessionManager`
  //    with the real implementation so chains genuinely run.
  const realSessionManager = new SessionManager({
    idGenerator: nextSessionId,
  });
  const { sprint, sprintTasks, cwd, expectedBranch: overrideBranch, ...tuiOpts } = opts;
  const tuiDeps = buildTuiDeps({
    ...tuiOpts,
    sprints: [sprint],
    tasks: [[sprint.id, sprintTasks]],
  });

  // Swap FakeSessionManager → real SessionManager. The cast is sound:
  // E2eDeps narrows the field, and we never read FakeSessionManager
  // mocks elsewhere in the harness.
  const deps: E2eDeps = {
    ...tuiDeps,
    sessionManager: realSessionManager,
  };
  setSharedDeps(deps);

  // 2. Pre-launch the chain. The CLI / TUI launchers do the same — build
  //    the flow at construction time, hand it to the SessionManager, and
  //    let the runner kick off asynchronously. The ExecuteView mounts
  //    against this live session.
  const expectedBranch = overrideBranch ?? sprint.branch ?? '';
  const flow = createExecuteFlow(deps, {
    sprintId: sprint.id,
    cwd,
    expectedBranch,
    sprint,
    tasks: sprintTasks,
  });
  const initialCtx: ExecuteCtx = {
    sprintId: sprint.id,
    cwd,
    expectedBranch,
  };
  const sessionId = realSessionManager.start({
    label: `execute ${String(sprint.id)}`,
    element: flow,
    initialCtx,
  });

  // Capture the runner's terminal state via a promise wired up immediately
  // after `start()` — this side-steps two pitfalls:
  //   - SessionManager.kill() deletes the record before our terminal handler
  //     would fetch it; subscribing here keeps a direct runner ref alive.
  //   - The runner's late-subscriber replay invokes the listener
  //     synchronously inside `subscribe`. We use a flag so the listener
  //     never references a not-yet-bound `unsub`.
  type TerminalStatus = 'completed' | 'failed' | 'aborted';
  const startedDescriptor = realSessionManager.get(sessionId);
  if (startedDescriptor === undefined) {
    throw new Error(`harness: session ${sessionId} not registered after start()`);
  }
  let terminalResolver: ((status: TerminalStatus) => void) | null = null;
  const terminalPromise = new Promise<TerminalStatus>((resolve) => {
    terminalResolver = resolve;
  });
  let terminalSeen: TerminalStatus | null = null;
  startedDescriptor.runner.subscribe((event) => {
    if (terminalSeen !== null) return;
    if (event.type === 'completed' || event.type === 'failed' || event.type === 'aborted') {
      terminalSeen = event.type;
      terminalResolver?.(event.type);
    }
  });

  // 3. Render the full <App /> rooted at the ExecuteView. This exercises
  //    the real router, the real ExecuteView component, the real signal
  //    bus subscriptions.
  const inkResult = render(
    <App initialView="execute" sessionId={sessionId} sessionManager={realSessionManager} signalBus={deps.signalBus} />
  );

  const harness: E2eHarness = {
    ...inkResult,
    deps,
    sessionId,
    waitForFrame: async (matcher, { timeout = 4000 } = {}) => {
      await vi.waitFor(
        () => {
          const frame = inkResult.lastFrame() ?? '';
          if (typeof matcher === 'string') {
            if (!frame.includes(matcher)) {
              throw new Error(`frame does not yet contain ${JSON.stringify(matcher)}`);
            }
          } else if (!matcher.test(frame)) {
            throw new Error(`frame does not yet match ${matcher.toString()}`);
          }
        },
        { timeout, interval: 25 }
      );
    },
    waitForTerminal: async ({ timeout = 4000 } = {}) => {
      // Race the captured-at-boot terminal promise against a timeout. The
      // subscription was wired immediately after `start()` so this is safe
      // against `SessionManager.kill()` deletes / async runner settlement.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<TerminalStatus>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`runner did not reach terminal state within ${String(timeout)}ms`));
        }, timeout);
      });
      try {
        return await Promise.race([terminalPromise, timeoutPromise]);
      } finally {
        clearTimeout(timer);
      }
    },
  };

  activeHarness = harness;
  return harness;
}
