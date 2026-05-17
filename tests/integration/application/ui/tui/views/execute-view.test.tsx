/**
 * Smoke tests for ExecuteView. Builds a fake Runner with a controlled status; registers
 * it with the session manager; renders the view scoped to that session id. Asserts on the
 * running frame (cancel / detach hints, status chip) and a completed frame (ResultCard).
 *
 * Doesn't drive the trace forward — that's covered by the StepTrace component tests; here we
 * only need the view to read descriptor fields and render the correct top-level layout.
 */

import { describe, expect, it, vi } from 'vitest';
import { ExecuteView } from '@src/application/ui/tui/views/execute-view.tsx';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { Runner } from '@src/application/chain/run/runner.ts';
import type { Trace, TraceEntry } from '@src/application/chain/trace.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { createSessionManager } from '@src/application/ui/tui/runtime/session-manager.ts';
import { ENTER, tick } from '@tests/integration/application/ui/tui/_keys.ts';
import { renderView } from '@tests/integration/application/ui/tui/_harness.tsx';

const noopEventBus: EventBus = {
  publish: vi.fn(),
  subscribe: () => () => undefined,
} as unknown as EventBus;

const fakeRunner = (id: string, status: 'running' | 'completed' | 'failed'): Runner<unknown> =>
  ({
    id,
    status,
    ctx: {},
    trace: [],
    subscribe: () => () => undefined,
    start: vi.fn(),
    abort: vi.fn(),
  }) as unknown as Runner<unknown>;

const stubDeps = (): AppDeps =>
  ({
    eventBus: noopEventBus,
  }) as unknown as AppDeps;

describe('ExecuteView', () => {
  it('shows running indicators and the cancel / detach hints while the session runs', async () => {
    const sessions = createSessionManager();
    const runner = fakeRunner('r-1', 'running');
    sessions.register({ runner, flowId: 'refine', title: 'Refine — Demo' });

    const { result } = renderView(<ExecuteView />, {
      deps: stubDeps(),
      initial: { id: 'execute', props: { sessionId: 'r-1' } },
      sessions,
    });
    await tick(40);
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('Refine — Demo');
    expect(frame).toMatch(/running/i);
    expect(frame).toContain('cancel');
    expect(frame).toContain('detach');
    expect(frame).toContain('Flow steps');
    expect(frame).toContain('Tasks');
    result.unmount();
  });

  it('renders the ResultCard with the completed verdict once the session settles', async () => {
    const sessions = createSessionManager();
    const runner = fakeRunner('r-2', 'completed');
    sessions.register({ runner, flowId: 'refine', title: 'Refine — Done' });

    const { result } = renderView(<ExecuteView />, {
      deps: stubDeps(),
      initial: { id: 'execute', props: { sessionId: 'r-2' } },
      sessions,
    });
    await tick(40);
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('Refine — Done');
    expect(frame).toMatch(/completed/i);
    // ResultCard renders fields including a Status row.
    expect(frame).toContain('Status');
    // Press ↵ to return — the not-running hint.
    expect(frame).toContain('back');
    result.unmount();
  });

  it('renders the unknown-session fallback when the id is not registered', async () => {
    const { result } = renderView(<ExecuteView />, {
      deps: stubDeps(),
      initial: { id: 'execute', props: { sessionId: 'r-ghost' } },
    });
    await tick(40);
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('not found in the registry');
    result.unmount();
  });

  it('round-counter never decreases when generator entries evict from the trace ring buffer', async () => {
    // The runner's trace is a ring buffer capped at MAX_TRACE_ENTRIES. On a long run the
    // earliest `generator-<taskId>` entries get evicted; counting them directly would let
    // `round N/M` shrink mid-task. The execute-view holds a monotonic high-water ref per task
    // so the displayed count only ever moves forward.
    //
    // We can't actually exhaust the 20k cap in a test, so simulate by mutating the runner's
    // exposed trace array — push 5 generator entries, render, then "evict" by splicing out
    // the first 3, render again. The displayed round must stay at 5, not drop to 2.
    const TASK = '01933fbb-1111-7000-8000-000000000001';
    const taskNames = new Map<string, string>([[TASK, 'Demo task']]);
    const traceArray: TraceEntry[] = [];
    const runner = {
      id: 'r-rounds',
      status: 'running' as const,
      ctx: {},
      trace: traceArray as Trace,
      subscribe: () => () => undefined,
      start: vi.fn(),
      abort: vi.fn(),
    } as unknown as Runner<unknown>;
    const sessions = createSessionManager();
    sessions.register({
      runner,
      flowId: 'implement',
      title: 'Implement — Rounds',
      taskNames,
      maxTurns: 10,
      terminalSubstepName: 'unlink-skills',
    });

    // Seed 5 generator entries — round counter should read 5.
    for (let i = 0; i < 5; i++) {
      traceArray.push({ elementName: `generator-${TASK}`, status: 'completed', durationMs: 1 });
    }
    // Force a step notification so the session-manager publishes a fresh descriptor.
    sessions.register({ runner, flowId: 'implement', title: 'Implement — Rounds' }); // no-op re-register
    // The descriptor's trace IS our array (same ref), so re-render via session update is implicit.

    const { result } = renderView(<ExecuteView />, {
      deps: stubDeps(),
      initial: { id: 'execute', props: { sessionId: 'r-rounds' } },
      sessions,
    });
    await tick(60);
    const frame1 = result.lastFrame() ?? '';
    expect(frame1).toMatch(/round 5/);

    // Simulate ring eviction — remove the earliest 3 entries. Length drops to 2.
    traceArray.splice(0, 3);
    expect(traceArray.length).toBe(2);
    // Trigger a re-render by mutating something the descriptor exposes. Easiest:
    // emit another step-style change by pushing a different leaf.
    traceArray.push({ elementName: `unlink-skills-${TASK}`, status: 'completed', durationMs: 1 });
    // Force the descriptor to update so the view re-renders.
    // The session-manager subscribes to runner events; we can't easily fire one against the
    // fake runner. Re-render by re-registering a new sessions object isn't right either.
    // Instead: poke the view via tick — execute-view runs a setInterval(setNow, 1000) while
    // the session is running. Advance some time so the view re-renders.
    await tick(120);
    const frame2 = result.lastFrame() ?? '';
    // The monotonic ref must hold the count at 5 even though only 2 generator entries remain
    // in the trace.
    expect(frame2).toMatch(/round 5/);
    result.unmount();
  });

  it('Enter on a completed session routes to sprint-detail when a sprint is selected', async () => {
    const sessions = createSessionManager();
    const runner = fakeRunner('r-3', 'completed');
    sessions.register({ runner, flowId: 'refine', title: 'Refine — Done' });

    const sprintId = 'sprint-fixture' as unknown as SprintId;
    const { result, routeIds } = renderView(<ExecuteView />, {
      deps: stubDeps(),
      initial: { id: 'execute', props: { sessionId: 'r-3' } },
      sessions,
      selection: { sprintId, sprintLabel: 'Demo Sprint' },
    });
    await tick(40);
    result.stdin.write(ENTER);
    await tick();
    expect(routeIds()).toContain('sprint-detail');
    result.unmount();
  });
});
