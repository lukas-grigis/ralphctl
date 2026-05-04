import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import { FeedbackPromptLoop } from './feedback-prompt-loop.tsx';
import { setSharedDeps, resetSharedDeps } from '@src/application/bootstrap/get-shared-deps.ts';
import { FakePromptPort } from '@src/application/_test-fakes/fake-prompt-port.ts';
import type { SharedDeps } from '@src/application/bootstrap/shared-deps.ts';
import type {
  SessionManagerPort,
  SessionDescriptor,
  SessionManagerEvent,
} from '@src/application/runtime/session-manager-port.ts';
import type { ChainRunnerListener } from '@src/kernel/runtime/chain-runner.ts';
import { Result } from '@src/domain/result.ts';
import type { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';

function makeFakeRunner(ctx: Record<string, unknown> = Object.create(null) as Record<string, unknown>) {
  return {
    id: 'fake-runner',
    get trace() {
      return [];
    },
    get status() {
      return 'running' as const;
    },
    subscribe: vi.fn((listener: ChainRunnerListener<unknown>) => {
      void listener;
      return () => undefined;
    }),
    emit: vi.fn(),
    abort: vi.fn(),
    start: vi.fn(),
    ctx,
  };
}

function makeDescriptor(overrides: Partial<SessionDescriptor> = {}): SessionDescriptor {
  const runnerCtx: Record<string, unknown> =
    (overrides.runner?.ctx as Record<string, unknown> | undefined) ?? (Object.create(null) as Record<string, unknown>);
  const runner = makeFakeRunner(runnerCtx);
  return {
    id: 'sess-execute',
    label: 'execute demo-sprint',
    status: 'completed',
    startedAt: '2026-05-01T12:00:00.000Z' as IsoTimestamp,
    runner,
    detachable: true,
    ...overrides,
  } as unknown as SessionDescriptor;
}

function makeSessionManager(): SessionManagerPort & {
  _emit(e: SessionManagerEvent): void;
  foregroundMock: ReturnType<typeof vi.fn>;
} {
  const listeners = new Set<(e: SessionManagerEvent) => void>();
  const foregroundMock = vi.fn(() => Result.ok());
  return {
    start: vi.fn(() => 'feedback-session'),
    list: vi.fn(() => []),
    get: vi.fn(() => undefined),
    foreground: foregroundMock,
    foregroundMock,
    background: vi.fn(() => Result.ok()),
    kill: vi.fn(() => Result.ok()),
    get active() {
      return null;
    },
    subscribe: vi.fn((l: (e: SessionManagerEvent) => void) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    }),
    dispose: vi.fn(),
    _emit: (e) => {
      for (const l of listeners) l(e);
    },
  };
}

beforeEach(() => {
  resetSharedDeps();
});
afterEach(() => {
  cleanup();
  resetSharedDeps();
});

describe('FeedbackPromptLoop', () => {
  it('renders null (no visible output)', () => {
    const sm = makeSessionManager();
    const descriptor = makeDescriptor();
    const { lastFrame } = render(
      <FeedbackPromptLoop descriptor={descriptor} sessionManager={sm} runnerStatus="completed" />
    );
    // Component renders null — no text output
    expect(lastFrame()?.trim() ?? '').toBe('');
  });

  it('does not prompt when descriptor is null', async () => {
    const promptPort = new FakePromptPort();
    setSharedDeps({ prompt: promptPort } as unknown as SharedDeps);
    const sm = makeSessionManager();
    render(<FeedbackPromptLoop descriptor={null} sessionManager={sm} runnerStatus={null} />);
    await new Promise((r) => setTimeout(r, 30));
    expect(promptPort.editorMock).not.toHaveBeenCalled();
  });

  it('does not prompt for non-execute sessions', async () => {
    const promptPort = new FakePromptPort();
    setSharedDeps({ prompt: promptPort } as unknown as SharedDeps);
    const sm = makeSessionManager();
    const descriptor = makeDescriptor({ label: 'refine sprint-001' });
    render(<FeedbackPromptLoop descriptor={descriptor} sessionManager={sm} runnerStatus="completed" />);
    await new Promise((r) => setTimeout(r, 30));
    expect(promptPort.editorMock).not.toHaveBeenCalled();
  });

  it('does not prompt when runnerStatus is not completed', async () => {
    const promptPort = new FakePromptPort();
    setSharedDeps({ prompt: promptPort } as unknown as SharedDeps);
    const sm = makeSessionManager();
    const descriptor = makeDescriptor();
    render(<FeedbackPromptLoop descriptor={descriptor} sessionManager={sm} runnerStatus="failed" />);
    await new Promise((r) => setTimeout(r, 30));
    expect(promptPort.editorMock).not.toHaveBeenCalled();
  });

  it('foregrounds the completing session and tags the prompt with the sprint id', async () => {
    const promptPort = new FakePromptPort();
    promptPort.queueEditor(null); // empty submit → terminate loop after one round
    setSharedDeps({ prompt: promptPort } as unknown as SharedDeps);
    const sm = makeSessionManager();
    const ctx = { sprintId: '20260504-060307-test', cwd: '/tmp/proj' } as unknown as Record<string, unknown>;
    const descriptor = makeDescriptor({
      id: 'sess-A',
      runner: makeFakeRunner(ctx) as unknown as SessionDescriptor['runner'],
    });
    render(<FeedbackPromptLoop descriptor={descriptor} sessionManager={sm} runnerStatus="completed" />);
    await new Promise((r) => setTimeout(r, 30));
    expect(sm.foregroundMock).toHaveBeenCalledWith('sess-A');
    expect(promptPort.editorMock).toHaveBeenCalledTimes(1);
    const call = promptPort.editorMock.mock.calls[0]?.[0] as { message: string } | undefined;
    expect(call?.message).toContain('20260504-060307-test');
  });
});
