/**
 * esc on the Execute view, through the real Layout + global keys: a run opened from Runs goes back to Runs (exactly
 * once — the view's own esc handler must not pop a second time), and the cancel-scope overlay's esc closes only itself.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExecuteView } from '@src/application/ui/tui/views/execute-view.tsx';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { Runner, RunnerStatus } from '@src/application/chain/run/runner.ts';
import { createSessionManager } from '@src/application/ui/tui/runtime/session-manager.ts';
import { BusesProvider, type SignalBusEntry } from '@src/application/ui/tui/runtime/sinks-context.tsx';
import { createBusSink } from '@src/application/ui/tui/runtime/sinks-bus.ts';
import type { LogEvent } from '@src/business/observability/events.ts';
import { makeReviewSprint } from '@tests/fixtures/domain.ts';
import { ESC } from '@tests/integration/application/ui/tui/_keys.ts';
import { waitForPredicate } from '@tests/integration/application/ui/tui/_wait.ts';
import { mountFrame, StubView } from '@tests/integration/application/ui/tui/_app-frame.tsx';

const noopEventBus = { publish: vi.fn(), subscribe: () => () => undefined } as unknown as EventBus;

const fakeRunner = (id: string, status: RunnerStatus): Runner<unknown> =>
  ({
    id,
    status,
    ctx: {},
    trace: [],
    subscribe: () => () => undefined,
    start: vi.fn(),
    abort: vi.fn(),
  }) as unknown as Runner<unknown>;

const deps = {
  eventBus: noopEventBus,
  sprintRepo: { findById: vi.fn().mockResolvedValue({ ok: true, value: makeReviewSprint() }) },
  sprintExecutionRepo: { findById: vi.fn().mockResolvedValue({ ok: false }) },
  taskRepo: {
    findById: vi.fn().mockResolvedValue({ ok: false }),
    findBySprintId: vi.fn().mockResolvedValue({ ok: true, value: [] }),
  },
} as unknown as AppDeps;

const buses = {
  harness: createBusSink<SignalBusEntry>({ maxEntries: 10 }),
  log: createBusSink<LogEvent>({ maxEntries: 10 }),
};

const open = (status: RunnerStatus): ReturnType<typeof mountFrame> => {
  const sessions = createSessionManager();
  sessions.register({ runner: fakeRunner('r-esc', status), flowId: 'implement', title: 'Implement — Esc' });
  const frame = mountFrame({
    columns: 100,
    rows: 40,
    deps,
    sessions,
    initial: { id: 'sessions' },
    renderRoute: (entry) =>
      entry.id === 'execute' ? (
        <BusesProvider value={buses}>
          <ExecuteView />
        </BusesProvider>
      ) : (
        <StubView id={entry.id} />
      ),
  });
  frame.router().push({ id: 'execute', props: { sessionId: 'r-esc' } });
  return frame;
};

const lastFrame = (f: ReturnType<typeof mountFrame>): string => f.result.lastFrame() ?? '';

afterEach(() => {
  vi.clearAllMocks();
});

describe('Execute esc through the global keys', () => {
  it('a settled run opened from Runs goes back to Runs, not past it to Work', async () => {
    const f = open('completed');
    await waitForPredicate(() => lastFrame(f).includes('esc Runs'), { label: 'settled footer' });
    f.result.stdin.write(ESC);
    await waitForPredicate(() => f.router().current.id === 'sessions', { label: 'back on Runs' });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(f.router().current.id).toBe('sessions');
    expect(f.router().activeSection).toBe('runs');
    f.result.unmount();
  });

  it('esc inside the cancel-scope overlay closes the overlay and stays on the run', async () => {
    const f = open('running');
    await waitForPredicate(() => lastFrame(f).includes('c cancel'), { label: 'running footer' });
    f.result.stdin.write('c');
    await waitForPredicate(() => lastFrame(f).includes('Cancel — pick a scope'), { label: 'overlay open' });
    expect(lastFrame(f)).not.toContain('esc Runs');
    f.result.stdin.write(ESC);
    await waitForPredicate(() => !lastFrame(f).includes('Cancel — pick a scope'), { label: 'overlay closed' });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(f.router().current.id).toBe('execute');
    expect(f.router().stack.map((e) => e.id)).toEqual(['sessions', 'execute']);
    f.result.unmount();
  });
});
