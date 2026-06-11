/**
 * Smoke + regression tests for SessionsView.
 *
 * Smoke: empty state when no sessions; populated row when one is registered.
 *
 * Regression (audit L7): the focus cursor is identity-based (keyed on the session id, not a list
 * index). When the list reorders or an earlier session is evicted, the cursor must stay on the
 * SAME logical session — not jump to whatever now sits at the old index. The focused row is the
 * one prefixed by the action-cursor glyph (`▸`), so we assert against that prefix.
 */

import { describe, expect, it, vi } from 'vitest';
import { SessionsView } from '@src/application/ui/tui/views/sessions-view.tsx';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import {
  createSessionManager,
  type SessionManager,
  type SessionRecord,
} from '@src/application/ui/tui/runtime/session-manager.ts';
import type { Runner } from '@src/application/chain/run/runner.ts';
import { glyphs } from '@src/application/ui/tui/theme/tokens.ts';
import { DOWN, tick, waitFor } from '@tests/integration/application/ui/tui/_keys.ts';
import { renderView, waitForViewReady } from '@tests/integration/application/ui/tui/_harness.tsx';

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

/** Minimal SessionRecord for the controllable manager — only the descriptor fields the view reads. */
const fakeRecord = (id: string, title: string, status: 'running' | 'completed'): SessionRecord =>
  ({
    descriptor: { id, flowId: 'implement', title, status, startedAt: 0, trace: [] },
    runner: fakeRunner(id, status),
  }) as unknown as SessionRecord;

/**
 * A SessionManager whose `list()` returns a mutable array the test controls, with a `setList`
 * helper that swaps the array and notifies subscribers — so we can drive deterministic reorder
 * and eviction (which the real LRU/age-sorted manager won't reproduce on demand). Only the
 * members SessionsView touches are real; the rest throw if accidentally exercised.
 */
const controllableManager = (
  initial: readonly SessionRecord[]
): { manager: SessionManager; setList: (next: readonly SessionRecord[]) => void } => {
  let current = initial;
  const listeners = new Set<() => void>();
  const manager = {
    list: () => current,
    get: (id: string) => current.find((r) => r.descriptor.id === id),
    abort: vi.fn(),
    remove: vi.fn(),
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  } as unknown as SessionManager;
  const setList = (next: readonly SessionRecord[]): void => {
    current = next;
    for (const fn of [...listeners]) fn();
  };
  return { manager, setList };
};

/** The session id whose row is prefixed by the focus cursor glyph (`▸`) in the rendered frame. */
const focusedTitle = (frame: string): string | undefined =>
  frame
    .split('\n')
    .find((line) => line.includes(glyphs.actionCursor))
    ?.trim();

describe('SessionsView', () => {
  it('shows the empty state when no sessions are registered', async () => {
    const { result } = renderView(<SessionsView />, {
      deps: emptyDeps,
      initial: { id: 'sessions' },
      sessions: createSessionManager(),
    });
    await waitForViewReady(result, (f) => f.includes('No sessions yet'));
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
    await waitForViewReady(result, (f) => f.includes('Refine — Demo'));
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('Refine — Demo');
    expect(frame).toContain('refine');
    expect(frame).toContain('running');
    expect(frame).toContain('1 session(s)');
    result.unmount();
  });

  it('keeps the cursor on the same session id after the list reorders (L7)', async () => {
    const a = fakeRecord('s-a', 'Alpha', 'running');
    const b = fakeRecord('s-b', 'Bravo', 'running');
    const c = fakeRecord('s-c', 'Charlie', 'running');
    const { manager, setList } = controllableManager([a, b, c]);

    const { result } = renderView(<SessionsView />, {
      deps: emptyDeps,
      initial: { id: 'sessions' },
      sessions: manager,
    });
    await waitForViewReady(result, (f) => f.includes('Alpha'));

    // Move the cursor onto the middle session (Bravo, id s-b).
    result.stdin.write(DOWN);
    await waitFor(() => (focusedTitle(result.lastFrame() ?? '') ?? '').includes('Bravo'));
    expect(focusedTitle(result.lastFrame() ?? '')).toContain('Bravo');

    // Reorder so the index that used to hold Bravo now holds a different session. The cursor
    // must follow the id (Bravo), not the old index-1 slot.
    setList([c, a, b]);
    await waitFor(() => (focusedTitle(result.lastFrame() ?? '') ?? '').includes('Bravo'));
    expect(focusedTitle(result.lastFrame() ?? '')).toContain('Bravo');

    result.unmount();
  });

  it('snaps the cursor to a survivor after the focused session is evicted, and focus targets the cursor row (L7)', async () => {
    const a = fakeRecord('s-a', 'Alpha', 'running');
    const b = fakeRecord('s-b', 'Bravo', 'running');
    const c = fakeRecord('s-c', 'Charlie', 'running');
    const { manager, setList } = controllableManager([a, b, c]);

    const routed: string[] = [];
    const { result } = renderView(<SessionsView />, {
      deps: emptyDeps,
      initial: { id: 'sessions' },
      sessions: manager,
      onRoute: (entry) => {
        if (entry.id === 'execute') routed.push((entry.props as { sessionId: string }).sessionId);
      },
    });
    await waitForViewReady(result, (f) => f.includes('Alpha'));

    // Focus Bravo, then evict Bravo. The cursor snaps to a survivor (by prior index, clamped).
    result.stdin.write(DOWN);
    await waitFor(() => (focusedTitle(result.lastFrame() ?? '') ?? '').includes('Bravo'));
    expect(focusedTitle(result.lastFrame() ?? '')).toContain('Bravo');

    setList([a, c]);
    await tick(40);
    const survivorTitle = focusedTitle(result.lastFrame() ?? '');
    expect(survivorTitle).toBeDefined();
    expect(survivorTitle).not.toContain('Bravo');

    // Enter must open the execute view for the session the cursor now sits on — not the evicted
    // one. The cursor landed on Charlie (prior index 1, clamped into the 2-item list).
    result.stdin.write('\r');
    await waitFor(() => routed.length > 0);
    expect(routed.at(-1)).toBe('s-c');

    result.unmount();
  });
});
