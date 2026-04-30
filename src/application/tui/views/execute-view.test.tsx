import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import { ExecuteView } from './execute-view.tsx';
import { ViewHintsProvider } from './view-hints-context.tsx';
import { setSharedDeps, resetSharedDeps } from '../../bootstrap/get-shared-deps.ts';
import { FakePromptPort } from '../../_test-fakes/fake-prompt-port.ts';
import type { SharedDeps } from '../../bootstrap/shared-deps.ts';
import type { SessionManagerPort, SessionDescriptor, SessionManagerEvent } from '../../runtime/session-manager-port.ts';
import type { SignalBusPort, SignalBusEvent } from '../../../business/ports/signal-bus-port.ts';
import type { ChainRunnerListener } from '../../../kernel/runtime/chain-runner.ts';
import type { ChainTraceEntry } from '../../../kernel/chain/element.ts';
import { Result } from 'typescript-result';
import { IsoTimestamp } from '../../../domain/values/iso-timestamp.ts';

// ── fakes ─────────────────────────────────────────────────────────────────────

type RunnerListeners = Set<ChainRunnerListener<unknown>>;

/**
 * Build a minimal fake ChainRunner that lets the test push events manually.
 * `emit(event)` delivers to all subscribers synchronously.
 */
function makeFakeRunner(initialTrace: ChainTraceEntry[] = []) {
  const listeners: RunnerListeners = new Set();
  const runner = {
    id: 'fake-runner',
    get trace() {
      return initialTrace;
    },
    get status() {
      return 'running' as const;
    },
    subscribe: vi.fn((l: ChainRunnerListener<unknown>) => {
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
    ctx: {},
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
  it('shows info card when no session is active', () => {
    const sm = makeSessionManager(null);
    const { lastFrame } = render(
      <ViewHintsProvider>
        <ExecuteView sessionManager={sm} />
      </ViewHintsProvider>
    );
    expect(lastFrame()).toContain('No active session');
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

  it('renders steps from initial trace (late-subscriber path)', () => {
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
    // Trace is seeded synchronously in useState initializer — no await needed
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
    expect(lastFrame()).toContain('completed');
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

  it('signalBus rate-limit-paused renders the banner with countdown', async () => {
    const bus = makeFakeSignalBus();
    const session = makeSession();
    const sm = makeSessionManager(session);
    const { lastFrame } = render(
      <ViewHintsProvider>
        <ExecuteView sessionId="sess-1" sessionManager={sm} signalBus={bus} />
      </ViewHintsProvider>
    );

    // Emit a paused event with resumeAt 30s in the future.
    const resumeAt = new Date(Date.now() + 30_000).toISOString() as IsoTimestamp;
    bus._emit({ type: 'rate-limit-paused', reason: 'upstream 429', resumeAt });
    await new Promise((r) => setTimeout(r, 50));
    expect(lastFrame()).toContain('Rate limit');
    // Countdown text reflects ~30s; allow ±2s tolerance for scheduling jitter.
    expect(lastFrame()).toMatch(/resuming in (28|29|30)s/);

    // Resume — banner clears.
    bus._emit({ type: 'rate-limit-resumed' });
    await new Promise((r) => setTimeout(r, 50));
    expect(lastFrame()).not.toContain('Rate limit');
  });
});
