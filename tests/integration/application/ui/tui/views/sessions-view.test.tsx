/**
 * Smoke tests for SessionsView. Empty state when no sessions; populated row when one is
 * registered via the session manager.
 */

import { describe, expect, it, vi } from 'vitest';
import { SessionsView } from '@src/application/ui/tui/views/sessions-view.tsx';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import { createSessionManager } from '@src/application/ui/tui/runtime/session-manager.ts';
import type { Runner } from '@src/application/chain/run/runner.ts';
import { tick } from '@tests/integration/application/ui/tui/_keys.ts';
import { renderView } from '@tests/integration/application/ui/tui/_harness.tsx';

const emptyDeps: AppDeps = {} as unknown as AppDeps;

/**
 * Build a fake Runner exposing the fields the session manager pulls on registration:
 * `id`, `status`, `trace`, plus the lifecycle subscribe. Tests don't drive the trace forward.
 */
const fakeRunner = (id: string, status: 'running' | 'completed'): Runner<unknown> =>
  ({
    id,
    status,
    trace: [],
    subscribe: () => () => undefined,
    start: vi.fn(),
    abort: vi.fn(),
  }) as unknown as Runner<unknown>;

describe('SessionsView', () => {
  it('shows the empty state when no sessions are registered', async () => {
    const { result } = renderView(<SessionsView />, {
      deps: emptyDeps,
      initial: { id: 'sessions' },
      sessions: createSessionManager(),
    });
    await tick(40);
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('No sessions yet');
    result.unmount();
  });

  it('lists a registered session with its title and flow id', async () => {
    const sessions = createSessionManager();
    sessions.register({
      runner: fakeRunner('r-1', 'running'),
      flowId: 'refine',
      title: 'Refine — Demo',
    });
    const { result } = renderView(<SessionsView />, {
      deps: emptyDeps,
      initial: { id: 'sessions' },
      sessions,
    });
    await tick(40);
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('Refine — Demo');
    expect(frame).toContain('refine');
    expect(frame).toContain('running');
    expect(frame).toContain('1 session(s)');
    result.unmount();
  });
});
