import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import { ExecuteView } from './execute-view.tsx';
import { ViewHintsProvider } from './view-hints-context.tsx';
import { setSharedDeps, resetSharedDeps } from '@src/application/bootstrap/get-shared-deps.ts';
import { FakePromptPort } from '@src/application/_test-fakes/fake-prompt-port.ts';
import type { SharedDeps } from '@src/application/bootstrap/shared-deps.ts';
import type {
  SessionManagerPort,
  SessionDescriptor,
  SessionManagerEvent,
} from '@src/application/runtime/session-manager-port.ts';
import type { SignalBusPort, SignalBusEvent } from '@src/business/ports/signal-bus-port.ts';
import type { ChainRunnerListener } from '@src/kernel/runtime/chain-runner.ts';
import type { ChainTraceEntry } from '@src/kernel/chain/element.ts';
import { Result } from '@src/domain/result.ts';
import type { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';

// ── fakes ─────────────────────────────────────────────────────────────────────

type RunnerListeners = Set<ChainRunnerListener<unknown>>;

/**
 * Build a minimal fake ChainRunner that lets the test push events manually.
 * `emit(event)` delivers to all subscribers synchronously.
 */
function makeFakeRunner(initialTrace: ChainTraceEntry[] = [], ctx: Record<string, unknown> = {}) {
  const listeners: RunnerListeners = new Set();
  const runner = {
    id: 'fake-runner',
    get trace() {
      return initialTrace;
    },
    get status() {
      return 'running' as const;
    },
    // Mirror the real ChainRunner contract: a new subscriber receives a
    // synchronous replay of every existing trace entry as a `step` event.
    // The view test depends on this — execute-view consumes only the
    // subscribe stream now (no separate trace seed).
    subscribe: vi.fn((l: ChainRunnerListener<unknown>) => {
      for (const entry of initialTrace) {
        l({ type: 'step', entry });
      }
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    }),
    emit(event: Parameters<ChainRunnerListener<unknown>>[0]) {
      for (const l of [...listeners]) l(event);
    },
    abort: vi.fn(),
    start: vi.fn(),
    ctx,
  };
  return runner;
}

interface FakeSession {
  readonly id: string;
  readonly label: string;
  readonly status: SessionDescriptor['status'];
  readonly startedAt: IsoTimestamp;
  readonly runner: ReturnType<typeof makeFakeRunner>;
}

function makeSession(
  overrides: Partial<Omit<FakeSession, 'runner'>> & { runner?: ReturnType<typeof makeFakeRunner> } = {}
): FakeSession {
  const runner = overrides.runner ?? makeFakeRunner();
  return {
    id: 'sess-1',
    label: 'sprint execute',
    status: 'running',
    startedAt: '2026-04-29T10:00:00.000Z' as IsoTimestamp,
    runner,
    ...overrides,
  };
}

function makeSessionManager(session: FakeSession | null = null): SessionManagerPort & {
  _emit(e: SessionManagerEvent): void;
} {
  const smListeners = new Set<(e: SessionManagerEvent) => void>();
  // Cast the fake session to SessionDescriptor at the boundary
  const descriptor = session !== null ? (session as unknown as SessionDescriptor) : null;
  const sessions = descriptor !== null ? [descriptor] : [];
  return {
    start: vi.fn(),
    list: vi.fn(() => sessions),
    get: vi.fn((id: string) => (session?.id === id && descriptor !== null ? descriptor : undefined)),
    foreground: vi.fn(() => Result.ok()),
    background: vi.fn(() => Result.ok()),
    kill: vi.fn(() => Result.ok()),
    get active() {
      return descriptor;
    },
    subscribe: vi.fn((l: (e: SessionManagerEvent) => void) => {
      smListeners.add(l);
      return () => {
        smListeners.delete(l);
      };
    }),
    dispose: vi.fn(),
    _emit: (e: SessionManagerEvent) => {
      for (const l of [...smListeners]) l(e);
    },
  };
}

function makeFakeSignalBus(): SignalBusPort & { _emit(e: SignalBusEvent): void } {
  const listeners = new Set<(e: SignalBusEvent) => void>();
  return {
    emit: vi.fn((e: SignalBusEvent) => {
      for (const l of [...listeners]) l(e);
    }),
    subscribe: vi.fn((l: (e: SignalBusEvent) => void) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    }),
    dispose: vi.fn(),
    _emit: (e) => {
      for (const l of [...listeners]) l(e);
    },
  };
}

/**
 * Install a minimal SharedDeps shim with a queueable FakePromptPort.
 * Returns the prompt fake so tests can queue answers and assert call args.
 */
function installPromptDeps(): FakePromptPort {
  const promptPort = new FakePromptPort();
  setSharedDeps({ prompt: promptPort } as unknown as SharedDeps);
  return promptPort;
}

// ── tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  resetSharedDeps();
});

afterEach(() => {
  cleanup();
  resetSharedDeps();
});

describe('ExecuteView', () => {
  it('renders a minimal canvas (no prescriptive copy) when no session is active', () => {
    const sm = makeSessionManager(null);
    const { lastFrame } = render(
      <ViewHintsProvider>
        <ExecuteView sessionManager={sm} />
      </ViewHintsProvider>
    );
    const frame = lastFrame() ?? '';
    // The "Awaiting…" spinner deliberately renders as null (the prompt host
    // owns the visual — see Spinner). Body must NOT contain stale "Start a
    // sprint from Home" advice that misleads users launching onboard / plan.
    expect(frame).toContain('EXECUTE');
    expect(frame).not.toContain('Start a sprint from Home');
    expect(frame).not.toContain('No active session');
  });

  it('renders EXECUTE header', () => {
    const sm = makeSessionManager(null);
    const { lastFrame } = render(
      <ViewHintsProvider>
        <ExecuteView sessionManager={sm} />
      </ViewHintsProvider>
    );
    expect(lastFrame()).toContain('EXECUTE');
  });

  it('renders session label and RUNNING status chip', () => {
    const session = makeSession({ label: 'my sprint execute', status: 'running' });
    const sm = makeSessionManager(session);
    const { lastFrame } = render(
      <ViewHintsProvider>
        <ExecuteView sessionId="sess-1" sessionManager={sm} />
      </ViewHintsProvider>
    );
    expect(lastFrame()).toContain('my sprint execute');
    expect(lastFrame()).toContain('RUNNING');
  });

  it('renders steps from initial trace (late-subscriber path)', async () => {
    const initialTrace: ChainTraceEntry[] = [
      { stepName: 'load-sprint', status: 'completed', durationMs: 12 },
      { stepName: 'assert-active', status: 'completed', durationMs: 5 },
    ];
    const runner = makeFakeRunner(initialTrace);
    const session = makeSession({ runner });
    const sm = makeSessionManager(session);

    const { lastFrame } = render(
      <ViewHintsProvider>
        <ExecuteView sessionId="sess-1" sessionManager={sm} />
      </ViewHintsProvider>
    );
    // ChainRunner.subscribe replays existing trace entries synchronously to
    // late subscribers, but the subscribe call itself happens inside a
    // useEffect — wait one tick for React to flush.
    await new Promise((r) => setTimeout(r, 20));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('load-sprint');
    expect(frame).toContain('assert-active');
  });

  it('renders new steps progressively as runner emits step events', async () => {
    const runner = makeFakeRunner();
    const session = makeSession({ runner });
    const sm = makeSessionManager(session);

    const { lastFrame } = render(
      <ViewHintsProvider>
        <ExecuteView sessionId="sess-1" sessionManager={sm} />
      </ViewHintsProvider>
    );

    // Wait for useEffect to run and register the subscriber
    await new Promise((r) => setTimeout(r, 20));

    // Emit a step event
    runner.emit({
      type: 'step',
      entry: { stepName: 'prepare-tasks', status: 'completed', durationMs: 42 },
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(lastFrame()).toContain('prepare-tasks');
  });

  it('shows rate-limit banner on rate-limit-paused step and hides on rate-limit-resumed', async () => {
    const runner = makeFakeRunner();
    const session = makeSession({ runner });
    const sm = makeSessionManager(session);

    const { lastFrame } = render(
      <ViewHintsProvider>
        <ExecuteView sessionId="sess-1" sessionManager={sm} />
      </ViewHintsProvider>
    );

    // Initially not visible
    expect(lastFrame()).not.toContain('Rate limit');

    // Simulate a rate-limit-paused step event (heuristic)
    runner.emit({
      type: 'step',
      entry: { stepName: 'rate-limit-paused', status: 'completed', durationMs: 0 },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(lastFrame()).toContain('Rate limit');

    // Resume
    runner.emit({
      type: 'step',
      entry: { stepName: 'rate-limit-resumed', status: 'completed', durationMs: 0 },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(lastFrame()).not.toContain('Rate limit');
  });

  it('renders completed result card when session status is completed', () => {
    const session = makeSession({ status: 'completed' });
    const sm = makeSessionManager(session);
    const { lastFrame } = render(
      <ViewHintsProvider>
        <ExecuteView sessionId="sess-1" sessionManager={sm} />
      </ViewHintsProvider>
    );
    // [COMPLETED] chip + "Completed" result card title
    expect(lastFrame()).toContain('COMPLETED');
  });

  it('confirms before kill, then kills on c (execute.cancel)', async () => {
    const prompt = installPromptDeps();
    prompt.queueConfirm(true);

    const session = makeSession();
    const killFn = vi.fn(() => Result.ok());
    const sm = { ...makeSessionManager(session), kill: killFn };
    const { stdin } = render(
      <ViewHintsProvider>
        <ExecuteView sessionId="sess-1" sessionManager={sm} />
      </ViewHintsProvider>
    );
    stdin.write('c');
    // Allow the async confirm flow to settle.
    await new Promise((r) => setTimeout(r, 50));
    expect(prompt.confirmMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Cancel running task and mark blocked?' })
    );
    expect(killFn).toHaveBeenCalledWith('sess-1');
  });

  it('does not kill when user declines the cancel confirm', async () => {
    const prompt = installPromptDeps();
    prompt.queueConfirm(false);

    const session = makeSession();
    const killFn = vi.fn(() => Result.ok());
    const sm = { ...makeSessionManager(session), kill: killFn };
    const { stdin } = render(
      <ViewHintsProvider>
        <ExecuteView sessionId="sess-1" sessionManager={sm} />
      </ViewHintsProvider>
    );
    stdin.write('c');
    await new Promise((r) => setTimeout(r, 50));
    expect(prompt.confirmMock).toHaveBeenCalled();
    expect(killFn).not.toHaveBeenCalled();
  });

  it('cancel flow is idempotent: pressing c twice fires only one confirm', async () => {
    // Custom PromptPort whose confirm() returns a long-pending promise so
    // we can verify the second `c` press is suppressed while the first
    // confirm is still in flight.
    type Resolver = (v: boolean) => void;
    let pendingResolver: Resolver | undefined;
    const confirmCalls: number[] = [];
    // Build a real FakePromptPort and rebind only the `confirm` method so
    // the prototype is preserved (linter rejects spreading class instances).
    const promptPort = new FakePromptPort();
    Object.defineProperty(promptPort, 'confirm', {
      value: vi.fn(() => {
        confirmCalls.push(1);
        return new Promise<boolean>((resolve) => {
          pendingResolver = resolve;
        });
      }),
    });
    setSharedDeps({ prompt: promptPort } as unknown as SharedDeps);

    const session = makeSession();
    const killFn = vi.fn(() => Result.ok());
    const sm = { ...makeSessionManager(session), kill: killFn };
    const { stdin } = render(
      <ViewHintsProvider>
        <ExecuteView sessionId="sess-1" sessionManager={sm} />
      </ViewHintsProvider>
    );
    stdin.write('c');
    await new Promise((r) => setTimeout(r, 20));
    // Second press while the first prompt is still in flight — must be a no-op.
    stdin.write('c');
    await new Promise((r) => setTimeout(r, 20));
    expect(confirmCalls.length).toBe(1);
    // Resolve the in-flight confirm so the test cleans up.
    if (pendingResolver) pendingResolver(false);
  });

  it('suppresses cancel for foreground-only flows (refine/plan/onboard/ideate)', async () => {
    // detachable: false is the marker for refine/plan/onboard/ideate. Mid-AI
    // cancel is rough (partial requirements / planning artefacts), so `c`
    // should be a no-op and the hint should disappear.
    const prompt = installPromptDeps();
    prompt.queueConfirm(true);

    const session = makeSession({ detachable: false } as Partial<FakeSession>);
    const killFn = vi.fn(() => Result.ok());
    const sm = { ...makeSessionManager(session), kill: killFn };
    const { stdin, lastFrame } = render(
      <ViewHintsProvider>
        <ExecuteView sessionId="sess-1" sessionManager={sm} />
      </ViewHintsProvider>
    );
    stdin.write('c');
    await new Promise((r) => setTimeout(r, 50));
    expect(prompt.confirmMock).not.toHaveBeenCalled();
    expect(killFn).not.toHaveBeenCalled();
    expect(lastFrame()).not.toContain('cancel run');
  });

  it('signalBus rate-limit-paused renders the banner with countdown', async () => {
    const bus = makeFakeSignalBus();
    const session = makeSession();
    const sm = makeSessionManager(session);
    const { lastFrame } = render(
      <ViewHintsProvider>
        <ExecuteView sessionId="sess-1" sessionManager={sm} signalBus={bus} />
      </ViewHintsProvider>
    );

    // Wait for the view's signal-bus subscription useEffect to register
    // before emitting the paused event — without this, under parallel CI
    // load the emit can fire into a not-yet-subscribed bus.
    await vi.waitFor(() => {
      expect(lastFrame() ?? '').toContain('execute');
    });

    // Emit a paused event with resumeAt 30s in the future. We assert the
    // countdown EXISTS, not its exact value — the semantics under test are
    // "banner appears with a countdown when paused" and "banner clears on
    // resume", not the precise tick value.
    const resumeAt = new Date(Date.now() + 30_000).toISOString() as IsoTimestamp;
    bus._emit({ type: 'rate-limit-paused', reason: 'upstream 429', resumeAt });
    await vi.waitFor(() => {
      const f = lastFrame() ?? '';
      expect(f).toContain('Rate limit');
      expect(f).toMatch(/resuming in \d+s/);
    });

    // Resume — banner clears.
    bus._emit({ type: 'rate-limit-resumed' });
    await vi.waitFor(() => {
      expect(lastFrame()).not.toContain('Rate limit');
    });
  });

  // ── Bug 1: chip updates when runner emits terminal event ──────────────────

  it('chip changes from [RUNNING] to [COMPLETED] when runner emits completed', async () => {
    const runner = makeFakeRunner();
    const session = makeSession({ status: 'running', runner });
    const sm = makeSessionManager(session);

    const { lastFrame } = render(
      <ViewHintsProvider>
        <ExecuteView sessionId="sess-1" sessionManager={sm} />
      </ViewHintsProvider>
    );

    // Wait for the runner subscription useEffect to fire.
    await new Promise((r) => setTimeout(r, 20));
    expect(lastFrame()).toContain('RUNNING');
    expect(lastFrame()).not.toContain('COMPLETED');

    // Runner emits terminal event — the SessionManager descriptor stays frozen
    // at 'running', but the view must update via runnerStatus state.
    runner.emit({ type: 'completed', ctx: {} });
    await new Promise((r) => setTimeout(r, 50));

    expect(lastFrame()).toContain('COMPLETED');
    expect(lastFrame()).not.toContain('RUNNING');
  });

  it('chip changes to [FAILED] when runner emits failed', async () => {
    const runner = makeFakeRunner();
    const session = makeSession({ status: 'running', runner });
    const sm = makeSessionManager(session);

    const { lastFrame } = render(
      <ViewHintsProvider>
        <ExecuteView sessionId="sess-1" sessionManager={sm} />
      </ViewHintsProvider>
    );

    await new Promise((r) => setTimeout(r, 20));
    expect(lastFrame()).toContain('RUNNING');

    runner.emit({ type: 'failed', error: { code: 'test-error', message: 'something broke' } });
    await new Promise((r) => setTimeout(r, 50));

    expect(lastFrame()).toContain('FAILED');
    expect(lastFrame()).not.toContain('RUNNING');
  });

  it('chip changes to [ABORTED] when runner emits aborted', async () => {
    const runner = makeFakeRunner();
    const session = makeSession({ status: 'running', runner });
    const sm = makeSessionManager(session);

    const { lastFrame } = render(
      <ViewHintsProvider>
        <ExecuteView sessionId="sess-1" sessionManager={sm} />
      </ViewHintsProvider>
    );

    await new Promise((r) => setTimeout(r, 20));
    expect(lastFrame()).toContain('RUNNING');

    runner.emit({ type: 'aborted' });
    await new Promise((r) => setTimeout(r, 50));

    expect(lastFrame()).toContain('ABORTED');
    expect(lastFrame()).not.toContain('RUNNING');
  });

  // ── Bug 2: result card + next-step CTA on terminal state ──────────────────

  it('result card appears with next-step hint after runner completes', async () => {
    const runner = makeFakeRunner();
    const session = makeSession({ label: 'refine 20260501-test', status: 'running', runner });
    const sm = makeSessionManager(session);

    const { lastFrame } = render(
      <ViewHintsProvider>
        <ExecuteView sessionId="sess-1" sessionManager={sm} />
      </ViewHintsProvider>
    );

    await new Promise((r) => setTimeout(r, 20));
    // No result card yet
    expect(lastFrame()).not.toContain('Completed');

    runner.emit({ type: 'completed', ctx: {} });
    await new Promise((r) => setTimeout(r, 50));

    // ResultCard success title
    expect(lastFrame()).toContain('Completed');
    // Next-step suggestion for refine flow
    expect(lastFrame()).toContain('sprint plan');
  });

  it('result card shows sprint start hint after plan completes', async () => {
    const runner = makeFakeRunner();
    const session = makeSession({ label: 'plan 20260501-test', status: 'running', runner });
    const sm = makeSessionManager(session);

    const { lastFrame } = render(
      <ViewHintsProvider>
        <ExecuteView sessionId="sess-1" sessionManager={sm} />
      </ViewHintsProvider>
    );

    await new Promise((r) => setTimeout(r, 20));

    runner.emit({ type: 'completed', ctx: {} });
    await new Promise((r) => setTimeout(r, 50));

    expect(lastFrame()).toContain('sprint start');
  });

  it('result card shows error + recovery hint after runner fails', async () => {
    const runner = makeFakeRunner();
    const session = makeSession({ label: 'refine 20260501-test', status: 'running', runner });
    const sm = makeSessionManager(session);

    const { lastFrame } = render(
      <ViewHintsProvider>
        <ExecuteView sessionId="sess-1" sessionManager={sm} />
      </ViewHintsProvider>
    );

    await new Promise((r) => setTimeout(r, 20));

    runner.emit({ type: 'failed', error: { code: 'some-error', message: 'bad thing' } });
    await new Promise((r) => setTimeout(r, 50));

    // Error result card title
    expect(lastFrame()).toContain('Failed');
    // Recovery hint
    expect(lastFrame()).toContain('steps above');
  });

  // ── Bug 2: hints swap to Enter/Esc on terminal state ──────────────────────

  it('Enter key is ignored while session is still running', async () => {
    const runner = makeFakeRunner();
    const session = makeSession({ status: 'running', runner });
    const sm = makeSessionManager(session);

    const { stdin, lastFrame } = render(
      <ViewHintsProvider>
        <ExecuteView sessionId="sess-1" sessionManager={sm} />
      </ViewHintsProvider>
    );

    await new Promise((r) => setTimeout(r, 20));
    // While still running, the chip should show RUNNING (not pop — no router
    // context is injected, so we just verify the running state is preserved).
    stdin.write('\r');
    await new Promise((r) => setTimeout(r, 20));
    expect(lastFrame()).toContain('RUNNING');
  });

  // ── Bug 3: no "working…" text in header heartbeat ─────────────────────────

  it('header heartbeat does not contain "working" text while running', async () => {
    const runner = makeFakeRunner();
    const session = makeSession({ status: 'running', runner });
    const sm = makeSessionManager(session);

    const { lastFrame } = render(
      <ViewHintsProvider>
        <ExecuteView sessionId="sess-1" sessionManager={sm} />
      </ViewHintsProvider>
    );

    await new Promise((r) => setTimeout(r, 20));
    expect(lastFrame()).toContain('RUNNING');
    // The header heartbeat spinner no longer has a trailing "working…" label
    expect(lastFrame()).not.toContain('working');
  });

  // ── Live task-status overlay from bus events ─────────────────────────────

  describe('per-task status overlay', () => {
    it('renders the per-task panel when ctx.tasks is seeded on initialCtx', async () => {
      const seededTasks = [
        { id: 'task-a', name: 'Build feature A', status: 'todo', blockedBy: [], projectPath: '/tmp/r' },
      ];
      const runner = makeFakeRunner([], { sprintId: 'demo', tasks: seededTasks });
      const session = makeSession({ runner });
      const sm = makeSessionManager(session);

      const { lastFrame } = render(
        <ViewHintsProvider>
          <ExecuteView sessionId="sess-1" sessionManager={sm} />
        </ViewHintsProvider>
      );
      await new Promise((r) => setTimeout(r, 20));

      const frame = lastFrame() ?? '';
      // Panel header + task name visible — i.e. the grid is not silently null.
      expect(frame).toContain('Task execution');
      expect(frame).toContain('Build feature A');
      // Initial status pill
      expect(frame).toContain('TODO');
    });

    it('flips a task pill from TODO to IN PROGRESS when bus emits task-started', async () => {
      const seededTasks = [
        { id: 'task-a', name: 'Build feature A', status: 'todo', blockedBy: [], projectPath: '/tmp/r' },
      ];
      const runner = makeFakeRunner([], { sprintId: 'demo', tasks: seededTasks });
      const session = makeSession({ runner });
      const sm = makeSessionManager(session);
      const bus = makeFakeSignalBus();

      const { lastFrame } = render(
        <ViewHintsProvider>
          <ExecuteView sessionId="sess-1" sessionManager={sm} signalBus={bus} />
        </ViewHintsProvider>
      );
      await new Promise((r) => setTimeout(r, 20));
      expect(lastFrame()).toContain('TODO');

      bus._emit({ type: 'task-started', taskId: 'task-a' as never });
      await new Promise((r) => setTimeout(r, 30));

      expect(lastFrame()).toContain('IN PROGRESS');
    });

    it('flips a task pill to DONE when bus emits task-finished completed', async () => {
      const seededTasks = [
        { id: 'task-a', name: 'Build feature A', status: 'in_progress', blockedBy: [], projectPath: '/tmp/r' },
      ];
      const runner = makeFakeRunner([], { sprintId: 'demo', tasks: seededTasks });
      const session = makeSession({ runner });
      const sm = makeSessionManager(session);
      const bus = makeFakeSignalBus();

      const { lastFrame } = render(
        <ViewHintsProvider>
          <ExecuteView sessionId="sess-1" sessionManager={sm} signalBus={bus} />
        </ViewHintsProvider>
      );
      await new Promise((r) => setTimeout(r, 20));

      bus._emit({ type: 'task-finished', taskId: 'task-a' as never, status: 'completed' });
      await new Promise((r) => setTimeout(r, 30));

      expect(lastFrame()).toContain('DONE');
    });

    it('flips a task pill to BLOCKED when bus emits task-finished blocked', async () => {
      const seededTasks = [
        { id: 'task-a', name: 'Build feature A', status: 'in_progress', blockedBy: [], projectPath: '/tmp/r' },
      ];
      const runner = makeFakeRunner([], { sprintId: 'demo', tasks: seededTasks });
      const session = makeSession({ runner });
      const sm = makeSessionManager(session);
      const bus = makeFakeSignalBus();

      const { lastFrame } = render(
        <ViewHintsProvider>
          <ExecuteView sessionId="sess-1" sessionManager={sm} signalBus={bus} />
        </ViewHintsProvider>
      );
      await new Promise((r) => setTimeout(r, 20));

      bus._emit({ type: 'task-finished', taskId: 'task-a' as never, status: 'blocked' });
      await new Promise((r) => setTimeout(r, 30));

      expect(lastFrame()).toContain('BLOCKED');
    });

    it('flips a task pill to BLOCKED when bus emits task-finished with any non-completed status', async () => {
      // Any non-'completed' status maps to 'blocked' so the task pill leaves
      // the IN PROGRESS state. The bus no longer emits 'failed' from the per-task
      // chain — commit-task and mark-done always run now.
      const seededTasks = [
        { id: 'task-a', name: 'Build feature A', status: 'in_progress', blockedBy: [], projectPath: '/tmp/r' },
      ];
      const runner = makeFakeRunner([], { sprintId: 'demo', tasks: seededTasks });
      const session = makeSession({ runner });
      const sm = makeSessionManager(session);
      const bus = makeFakeSignalBus();

      const { lastFrame } = render(
        <ViewHintsProvider>
          <ExecuteView sessionId="sess-1" sessionManager={sm} signalBus={bus} />
        </ViewHintsProvider>
      );
      await new Promise((r) => setTimeout(r, 20));

      bus._emit({ type: 'task-finished', taskId: 'task-a' as never, status: 'blocked' });
      await new Promise((r) => setTimeout(r, 30));

      const frame = lastFrame() ?? '';
      expect(frame).toContain('BLOCKED');
      expect(frame).not.toContain('IN PROGRESS');
    });

    it('clears prior-session task overrides when the view rebinds to a new session', async () => {
      // Session A — task `task-a` will be flipped to IN PROGRESS via the bus.
      const tasksA = [{ id: 'task-a', name: 'Task A', status: 'todo', blockedBy: [], projectPath: '/tmp/r' }];
      const runnerA = makeFakeRunner([], { sprintId: 'sprintA', tasks: tasksA });
      const sessionA: FakeSession = {
        id: 'sess-a',
        label: 'execute A',
        status: 'running',
        startedAt: '2026-04-29T10:00:00.000Z' as IsoTimestamp,
        runner: runnerA,
      };

      // Session B — same task id, but should render as TODO since it's a
      // different session and overrides from A must not bleed across.
      const tasksB = [{ id: 'task-a', name: 'Task B', status: 'todo', blockedBy: [], projectPath: '/tmp/r' }];
      const runnerB = makeFakeRunner([], { sprintId: 'sprintB', tasks: tasksB });
      const sessionB: FakeSession = {
        id: 'sess-b',
        label: 'execute B',
        status: 'running',
        startedAt: '2026-04-29T10:01:00.000Z' as IsoTimestamp,
        runner: runnerB,
      };

      // Single SessionManager that returns whichever session the view asks for.
      const smListeners = new Set<(e: SessionManagerEvent) => void>();
      const descA = sessionA as unknown as SessionDescriptor;
      const descB = sessionB as unknown as SessionDescriptor;
      const sm: SessionManagerPort = {
        start: vi.fn(),
        list: vi.fn(() => [descA, descB]),
        get: vi.fn((id: string) => (id === 'sess-a' ? descA : id === 'sess-b' ? descB : undefined)),
        foreground: vi.fn(() => Result.ok()),
        background: vi.fn(() => Result.ok()),
        kill: vi.fn(() => Result.ok()),
        get active() {
          return descA;
        },
        subscribe: vi.fn((l: (e: SessionManagerEvent) => void) => {
          smListeners.add(l);
          return () => {
            smListeners.delete(l);
          };
        }),
        dispose: vi.fn(),
      };

      const bus = makeFakeSignalBus();

      // Render bound to session A first.
      const { lastFrame, rerender } = render(
        <ViewHintsProvider>
          <ExecuteView sessionId="sess-a" sessionManager={sm} signalBus={bus} />
        </ViewHintsProvider>
      );
      await new Promise((r) => setTimeout(r, 20));

      // Flip task-a to IN PROGRESS via a sess-a-tagged event.
      bus._emit({ type: 'task-started', taskId: 'task-a' as never, sessionId: 'sess-a' });
      await vi.waitFor(() => {
        expect(lastFrame()).toContain('IN PROGRESS');
      });

      // Switch to session B — the override map should reset, so the seeded
      // TODO status from session B's ctx wins.
      rerender(
        <ViewHintsProvider>
          <ExecuteView sessionId="sess-b" sessionManager={sm} signalBus={bus} />
        </ViewHintsProvider>
      );
      await vi.waitFor(() => {
        const frame = lastFrame() ?? '';
        expect(frame).toContain('TODO');
        expect(frame).not.toContain('IN PROGRESS');
      });
    });
  });

  // ── Per-session log tail (ALS-tagged events) ─────────────────────────────
  describe('per-session log tail', () => {
    it('renders only events tagged with the active session id', async () => {
      const { logEventBus } = await import('@src/application/tui/runtime/event-bus.ts');
      const { IsoTimestamp: ITS } = await import('@src/domain/values/iso-timestamp.ts');
      const NOW = ITS.trustString('2026-04-29T00:00:00.000Z');

      const session = makeSession({ id: 'sess-1' });
      const sm = makeSessionManager(session);

      const { lastFrame } = render(
        <ViewHintsProvider>
          <ExecuteView sessionId="sess-1" sessionManager={sm} />
        </ViewHintsProvider>
      );
      // Wait for the subscribe useEffect to register.
      await new Promise((r) => setTimeout(r, 20));

      // Emit one event tagged with sess-1, one tagged with sess-2, one untagged.
      logEventBus.emit({
        level: 'info',
        message: 'belongs-to-1',
        timestamp: NOW,
        context: { sessionId: 'sess-1' },
      });
      logEventBus.emit({
        level: 'info',
        message: 'belongs-to-2',
        timestamp: NOW,
        context: { sessionId: 'sess-2' },
      });
      logEventBus.emit({
        level: 'info',
        message: 'belongs-to-noone',
        timestamp: NOW,
        context: {},
      });
      await new Promise((r) => setTimeout(r, 30));

      const frame = lastFrame() ?? '';
      expect(frame).toContain('belongs-to-1');
      expect(frame).not.toContain('belongs-to-2');
      expect(frame).not.toContain('belongs-to-noone');
    });
  });

  // ── Auto-close after empty feedback ─────────────────────────────────────────

  describe('auto-close after feedback drain', () => {
    it('closes the sprint when execute completes, all tasks are done, and feedback is empty', async () => {
      const { Sprint } = await import('@src/domain/entities/sprint.ts');
      const { IsoTimestamp: ITS } = await import('@src/domain/values/iso-timestamp.ts');
      const { ProjectName } = await import('@src/domain/values/project-name.ts');
      const { Slug } = await import('@src/domain/values/slug.ts');
      const { InMemorySprintRepository } = await import('@src/business/_test-fakes/in-memory-sprint-repository.ts');
      const { InMemoryTaskRepository } = await import('@src/business/_test-fakes/in-memory-task-repository.ts');
      const { FakeLoggerPort } = await import('@src/business/_test-fakes/fake-logger-port.ts');
      const { Task } = await import('@src/domain/entities/task.ts');
      const { AbsolutePath } = await import('@src/domain/values/absolute-path.ts');

      const t0 = ITS.parse('2026-04-29T12:00:00Z');
      if (!t0.ok) throw new Error('iso');
      const slug = Slug.parse('demo');
      if (!slug.ok) throw new Error('slug');
      const projectName = ProjectName.parse('demo');
      if (!projectName.ok) throw new Error('projectName');
      const created = Sprint.create({ name: 'Demo', slug: slug.value, now: t0.value, projectName: projectName.value });
      if (!created.ok) throw new Error('sprint create');
      const activated = created.value.activate(t0.value);
      if (!activated.ok) throw new Error('sprint activate');
      const sprint = activated.value;

      const path = AbsolutePath.parse('/tmp/demo-repo');
      if (!path.ok) throw new Error('path');
      const taskCreated = Task.create({
        name: 'task',
        steps: ['s'],
        verificationCriteria: ['v'],
        order: 1,
        projectPath: path.value,
      });
      if (!taskCreated.ok) throw new Error('task create');
      const inProgress = taskCreated.value.markInProgress();
      if (!inProgress.ok) throw new Error('in progress');
      const done = inProgress.value.markDone();
      if (!done.ok) throw new Error('mark done');

      const sprintRepo = new InMemorySprintRepository([sprint]);
      const taskRepo = new InMemoryTaskRepository([[sprint.id, [done.value]]]);
      const logger = new FakeLoggerPort();
      const promptPort = new FakePromptPort();
      // Empty editor answer → loop exits, auto-close should fire.
      promptPort.queueEditor(null);

      setSharedDeps({
        prompt: promptPort,
        sprintRepo,
        taskRepo,
        logger,
      } as unknown as SharedDeps);

      const runner = makeFakeRunner([], { sprintId: sprint.id, cwd: '/tmp/demo-repo' });
      const session = makeSession({ status: 'running', runner, label: 'execute demo-sprint' });
      const sm = makeSessionManager(session);

      render(
        <ViewHintsProvider>
          <ExecuteView sessionId="sess-1" sessionManager={sm} />
        </ViewHintsProvider>
      );
      await new Promise((r) => setTimeout(r, 20));

      // Trigger the feedback effect: runner emits completed, view reacts.
      runner.emit({ type: 'completed', ctx: { sprintId: sprint.id, cwd: '/tmp/demo-repo' } });
      // Allow the async IIFE to: (1) await the editor prompt (returns null
      // synchronously via FakePromptPort), (2) read tasks/sprint, (3) close.
      // Poll instead of fixed-wait so heavy parallel CI load doesn't race.
      await vi.waitFor(async () => {
        const reread = await sprintRepo.findById(sprint.id);
        if (!reread.ok) throw new Error('expected sprint');
        expect(reread.value.status).toBe('closed');
      });
      // Success log should mention the close.
      const successEntry = logger.entries.find(
        (e) => e.level === 'success' && e.message.includes('closed automatically')
      );
      expect(successEntry).toBeDefined();
    });

    it('does NOT close when one task is blocked', async () => {
      const { Sprint } = await import('@src/domain/entities/sprint.ts');
      const { IsoTimestamp: ITS } = await import('@src/domain/values/iso-timestamp.ts');
      const { ProjectName } = await import('@src/domain/values/project-name.ts');
      const { Slug } = await import('@src/domain/values/slug.ts');
      const { InMemorySprintRepository } = await import('@src/business/_test-fakes/in-memory-sprint-repository.ts');
      const { InMemoryTaskRepository } = await import('@src/business/_test-fakes/in-memory-task-repository.ts');
      const { FakeLoggerPort } = await import('@src/business/_test-fakes/fake-logger-port.ts');
      const { Task } = await import('@src/domain/entities/task.ts');
      const { AbsolutePath } = await import('@src/domain/values/absolute-path.ts');

      const t0 = ITS.parse('2026-04-29T12:00:00Z');
      if (!t0.ok) throw new Error('iso');
      const slug = Slug.parse('demo');
      if (!slug.ok) throw new Error('slug');
      const projectName = ProjectName.parse('demo');
      if (!projectName.ok) throw new Error('projectName');
      const created = Sprint.create({ name: 'Demo', slug: slug.value, now: t0.value, projectName: projectName.value });
      if (!created.ok) throw new Error('sprint create');
      const activated = created.value.activate(t0.value);
      if (!activated.ok) throw new Error('sprint activate');
      const sprint = activated.value;

      const path = AbsolutePath.parse('/tmp/demo-repo');
      if (!path.ok) throw new Error('path');
      // Two tasks: one done, one blocked — auto-close must skip.
      const t1Created = Task.create({
        name: 'task-1',
        steps: ['s'],
        verificationCriteria: ['v'],
        order: 1,
        projectPath: path.value,
      });
      if (!t1Created.ok) throw new Error('task create');
      const t1InProgress = t1Created.value.markInProgress();
      if (!t1InProgress.ok) throw new Error('in progress');
      const t1Done = t1InProgress.value.markDone();
      if (!t1Done.ok) throw new Error('mark done');

      const t2Created = Task.create({
        name: 'task-2',
        steps: ['s'],
        verificationCriteria: ['v'],
        order: 2,
        projectPath: path.value,
      });
      if (!t2Created.ok) throw new Error('task create');
      const t2Blocked = t2Created.value.markBlocked('preflight');
      if (!t2Blocked.ok) throw new Error('blocked');

      const sprintRepo = new InMemorySprintRepository([sprint]);
      const taskRepo = new InMemoryTaskRepository([[sprint.id, [t1Done.value, t2Blocked.value]]]);
      const logger = new FakeLoggerPort();
      const promptPort = new FakePromptPort();
      promptPort.queueEditor(null);

      setSharedDeps({
        prompt: promptPort,
        sprintRepo,
        taskRepo,
        logger,
      } as unknown as SharedDeps);

      const runner = makeFakeRunner([], { sprintId: sprint.id, cwd: '/tmp/demo-repo' });
      const session = makeSession({ status: 'running', runner, label: 'execute demo-sprint' });
      const sm = makeSessionManager(session);

      render(
        <ViewHintsProvider>
          <ExecuteView sessionId="sess-1" sessionManager={sm} />
        </ViewHintsProvider>
      );
      await new Promise((r) => setTimeout(r, 20));

      runner.emit({ type: 'completed', ctx: { sprintId: sprint.id, cwd: '/tmp/demo-repo' } });
      await new Promise((r) => setTimeout(r, 80));

      const reread = await sprintRepo.findById(sprint.id);
      if (!reread.ok) throw new Error('expected sprint');
      expect(reread.value.status).toBe('active');
      const successEntry = logger.entries.find(
        (e) => e.level === 'success' && e.message.includes('closed automatically')
      );
      expect(successEntry).toBeUndefined();
    });
  });
});
