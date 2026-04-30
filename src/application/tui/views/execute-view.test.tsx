import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import { ExecuteView } from './execute-view.tsx';
import { ViewHintsProvider } from './view-hints-context.tsx';
import type { SessionManagerPort, SessionDescriptor, SessionManagerEvent } from '../../runtime/session-manager-port.ts';
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

// ── tests ─────────────────────────────────────────────────────────────────────

afterEach(() => {
  cleanup();
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

  it('kills session when c is pressed (execute.cancel)', () => {
    const session = makeSession();
    const killFn = vi.fn(() => Result.ok());
    const sm = { ...makeSessionManager(session), kill: killFn };
    const { stdin } = render(
      <ViewHintsProvider>
        <ExecuteView sessionId="sess-1" sessionManager={sm} />
      </ViewHintsProvider>
    );
    stdin.write('c');
    expect(killFn).toHaveBeenCalledWith('sess-1');
  });
});
