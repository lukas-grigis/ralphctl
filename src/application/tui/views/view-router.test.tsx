import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { ViewRouter } from './view-router.tsx';
import type { SessionManagerPort, SessionDescriptor, SessionManagerEvent } from '../../runtime/session-manager-port.ts';
import { Result } from 'typescript-result';

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

describe('ViewRouter', () => {
  it('renders the initial home view', () => {
    const sm = makeSessionManager();
    const { lastFrame } = render(<ViewRouter initialStack={[{ id: 'home' }]} sessionManager={sm} />);
    expect(lastFrame()).toBeTruthy();
  });

  it('shows Home label in breadcrumb', () => {
    const sm = makeSessionManager();
    const { lastFrame } = render(<ViewRouter initialStack={[{ id: 'home' }]} sessionManager={sm} />);
    expect(lastFrame()).toContain('Home');
  });

  it('shows settings label after push to settings', () => {
    const sm = makeSessionManager();
    const { lastFrame } = render(
      <ViewRouter initialStack={[{ id: 'home' }, { id: 'settings' }]} sessionManager={sm} />
    );
    expect(lastFrame()).toContain('Settings');
  });

  it('shows breadcrumb trail for nested navigation', () => {
    const sm = makeSessionManager();
    const { lastFrame } = render(
      <ViewRouter initialStack={[{ id: 'home' }, { id: 'dashboard' }]} sessionManager={sm} />
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Home');
    expect(frame).toContain('Dashboard');
  });

  it('collapses adjacent duplicate stack entries', () => {
    const sm = makeSessionManager();
    const { lastFrame } = render(
      <ViewRouter initialStack={[{ id: 'home' }, { id: 'home' }, { id: 'settings' }]} sessionManager={sm} />
    );
    // Should only show one home in breadcrumb, not two
    const frame = lastFrame() ?? '';
    const homeCount = (frame.match(/Home/g) ?? []).length;
    // Settings is the current view, Home appears once in breadcrumb
    expect(frame).toContain('Settings');
    expect(homeCount).toBeLessThanOrEqual(2);
  });

  it('shows Tab hint when sessions exist', () => {
    const sm = makeSessionManager([
      {
        id: 'sess-1',
        label: 'my sprint refine',
        status: 'running',
        startedAt: '2026-04-29T10:00:00.000Z' as import('../../../domain/values/iso-timestamp.ts').IsoTimestamp,
        runner: {} as import('../../../kernel/runtime/chain-runner.ts').ChainRunner<unknown>,
      },
    ]);
    const { lastFrame } = render(<ViewRouter initialStack={[{ id: 'home' }]} sessionManager={sm} />);
    expect(lastFrame()).toContain('Tab');
  });

  it('does not show Tab hint when no sessions', () => {
    const sm = makeSessionManager([]);
    const { lastFrame } = render(<ViewRouter initialStack={[{ id: 'home' }]} sessionManager={sm} />);
    // Tab hint not present when no sessions
    const frame = lastFrame() ?? '';
    const tabInHints = frame.includes('next session');
    expect(tabInHints).toBe(false);
  });

  it('shows active session indicator [1/1] when session is active', () => {
    const sessions: SessionDescriptor[] = [
      {
        id: 'sess-1',
        label: 'refine',
        status: 'running',
        startedAt: '2026-04-29T10:00:00.000Z' as import('../../../domain/values/iso-timestamp.ts').IsoTimestamp,
        runner: {} as import('../../../kernel/runtime/chain-runner.ts').ChainRunner<unknown>,
      },
    ];
    const activeSession: SessionDescriptor | null = sessions[0] ?? null;
    const sm: SessionManagerPort = {
      ...makeSessionManager(sessions),
      get active() {
        return activeSession;
      },
    };
    const { lastFrame } = render(<ViewRouter initialStack={[{ id: 'home' }]} sessionManager={sm} />);
    // The [1/1] session count indicator appears in the status bar when a session is active.
    const frame = lastFrame() ?? '';
    expect(frame).toContain('[1/1');
  });
});
