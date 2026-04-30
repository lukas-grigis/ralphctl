import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { SessionsView } from './sessions-view.tsx';
import type { SessionManagerPort, SessionDescriptor, SessionManagerEvent } from '../../runtime/session-manager-port.ts';
import { Result } from 'typescript-result';
import type { IsoTimestamp } from '../../../domain/values/iso-timestamp.ts';
import type { ChainRunner } from '../../../kernel/runtime/chain-runner.ts';
import { RouterProvider } from './router-context.ts';
import { ViewHintsProvider } from './view-hints-context.tsx';
import { KeyboardHints } from '../components/keyboard-hints.tsx';

function makeSessionManager(sessions: SessionDescriptor[] = []): SessionManagerPort {
  const listeners = new Set<(e: SessionManagerEvent) => void>();
  return {
    start: vi.fn(),
    list: vi.fn(() => sessions),
    get: vi.fn((id) => sessions.find((s) => s.id === id)),
    foreground: vi.fn(() => Result.ok()),
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
  };
}

function makeSession(overrides: Partial<SessionDescriptor> = {}): SessionDescriptor {
  return {
    id: 'sess-1',
    label: 'my sprint refine',
    status: 'running',
    startedAt: '2026-04-29T10:00:00.000Z' as IsoTimestamp,
    runner: {} as ChainRunner<unknown>,
    ...overrides,
  };
}

function makeRouter() {
  return {
    current: { id: 'sessions' as const },
    stack: [{ id: 'home' as const }, { id: 'sessions' as const }],
    push: vi.fn(),
    pop: vi.fn(),
    replace: vi.fn(),
    reset: vi.fn(),
  };
}

describe('SessionsView', () => {
  it('shows empty state when no sessions', () => {
    const sm = makeSessionManager([]);
    const router = makeRouter();
    const { lastFrame } = render(
      <RouterProvider value={router}>
        <SessionsView sessionManager={sm} />
      </RouterProvider>
    );
    expect(lastFrame()).toContain('No active sessions');
  });

  it('shows session labels when sessions exist', () => {
    const sm = makeSessionManager([
      makeSession({ id: 'sess-1', label: 'sprint refine' }),
      makeSession({ id: 'sess-2', label: 'sprint execute', status: 'completed' }),
    ]);
    const router = makeRouter();
    const { lastFrame } = render(
      <RouterProvider value={router}>
        <SessionsView sessionManager={sm} />
      </RouterProvider>
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('sprint refine');
    expect(frame).toContain('sprint execute');
  });

  it('shows status for each session', () => {
    const sm = makeSessionManager([makeSession({ status: 'running' })]);
    const router = makeRouter();
    const { lastFrame } = render(
      <RouterProvider value={router}>
        <SessionsView sessionManager={sm} />
      </RouterProvider>
    );
    expect(lastFrame()).toContain('RUNNING');
  });

  it('declares Tab / Ctrl+1..9 / kill hints via useViewHints', async () => {
    const sm = makeSessionManager([makeSession()]);
    const router = makeRouter();
    const { lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <SessionsView sessionManager={sm} />
          <KeyboardHints />
        </ViewHintsProvider>
      </RouterProvider>
    );
    // useViewHints uses useEffect — give React a tick to flush.
    await new Promise((r) => setTimeout(r, 20));
    // ink wraps long strings to fit the test terminal width, so we check for
    // substrings that survive a hard wrap.
    const frame = (lastFrame() ?? '').replace(/\s+/g, ' ');
    expect(frame).toContain('Tab');
    expect(frame).toContain('Ctrl+1');
    // `kill` wraps to `kil` in narrow test output; `kil` is a stable substring.
    expect(frame).toContain('kil');
  });

  it('calls kill on sessionManager when k is pressed', () => {
    const session = makeSession({ id: 'to-kill' });
    const killFn = vi.fn(() => Result.ok());
    const sm: SessionManagerPort = { ...makeSessionManager([session]), kill: killFn };
    const router = makeRouter();

    const { stdin } = render(
      <RouterProvider value={router}>
        <SessionsView sessionManager={sm} />
      </RouterProvider>
    );

    stdin.write('k');
    expect(killFn).toHaveBeenCalledWith('to-kill');
  });

  it('foregrounds session and navigates on Enter', () => {
    const session = makeSession({ id: 'sess-fg' });
    const foregroundFn = vi.fn(() => Result.ok());
    const sm: SessionManagerPort = { ...makeSessionManager([session]), foreground: foregroundFn };
    const router = makeRouter();

    const { stdin } = render(
      <RouterProvider value={router}>
        <SessionsView sessionManager={sm} />
      </RouterProvider>
    );

    stdin.write('\r');
    expect(foregroundFn).toHaveBeenCalledWith('sess-fg');
    expect(router.push).toHaveBeenCalledWith({
      id: 'execute',
      props: { sessionId: 'sess-fg' },
    });
  });
});
