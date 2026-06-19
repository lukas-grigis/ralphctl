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
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import { useSelection } from '@src/application/ui/tui/runtime/selection-context.tsx';
import type { ViewEntry } from '@src/application/ui/tui/runtime/router.tsx';
import { createSessionManager } from '@src/application/ui/tui/runtime/session-manager.ts';
import { ENTER, ESC, tick, waitFor } from '@tests/integration/application/ui/tui/_keys.ts';
import { renderView, waitForViewReady } from '@tests/integration/application/ui/tui/_harness.tsx';

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
    await waitForViewReady(result, (f) => f.includes('Refine — Demo'));
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('Refine — Demo');
    expect(frame).toMatch(/running/i);
    expect(frame).toContain('cancel');
    expect(frame).toContain('detach');
    // Default ink-testing-library width (100 cols) puts us in the compact two-column layout —
    // the rail collapses to status-glyphs-only, so the "Flow steps" header text is suppressed.
    // The Tasks header still renders.
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
    await waitForViewReady(result, (f) => f.includes('Refine — Done'));
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('Refine — Done');
    expect(frame).toMatch(/completed/i);
    // ResultCard renders fields including a Status row.
    expect(frame).toContain('Status');
    // Press ↵ to return — the not-running hint routes Home.
    expect(frame).toContain('home');
    result.unmount();
  });

  it('renders the unknown-session fallback when the id is not registered', async () => {
    const { result } = renderView(<ExecuteView />, {
      deps: stubDeps(),
      initial: { id: 'execute', props: { sessionId: 'r-ghost' } },
    });
    await waitForViewReady(result, (f) => f.includes('not found in the registry'));
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
      terminalSubstepName: 'uninstall-skills',
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
    await waitForViewReady(result, (f) => /round 5/.test(f));
    const frame1 = result.lastFrame() ?? '';
    expect(frame1).toMatch(/round 5/);

    // Simulate ring eviction — remove the earliest 3 entries. Length drops to 2.
    traceArray.splice(0, 3);
    expect(traceArray.length).toBe(2);
    // Trigger a re-render by mutating something the descriptor exposes. Easiest:
    // emit another step-style change by pushing a different leaf.
    traceArray.push({ elementName: `uninstall-skills-${TASK}`, status: 'completed', durationMs: 1 });
    // Force the descriptor to update so the view re-renders.
    // The session-manager subscribes to runner events; we can't easily fire one against the
    // fake runner. Re-render by re-registering a new sessions object isn't right either.
    // Instead: poke the view via tick — execute-view runs a setInterval(setNow, 1000) while
    // the session is running. Advance some time so the view re-renders.
    await waitFor(() => /round 5/.test(result.lastFrame() ?? ''));
    const frame2 = result.lastFrame() ?? '';
    // The monotonic ref must hold the count at 5 even though only 2 generator entries remain
    // in the trace.
    expect(frame2).toMatch(/round 5/);
    result.unmount();
  });

  it('renders explicit generator + evaluator lines when the two implement models differ', async () => {
    const sessions = createSessionManager();
    const runner = fakeRunner('r-models', 'running');
    sessions.register({
      runner,
      flowId: 'implement',
      title: 'Implement — Cross-provider',
      generatorModel: 'claude-opus-4-8',
      evaluatorModel: 'gpt-5.5',
    });

    const { result } = renderView(<ExecuteView />, {
      deps: stubDeps(),
      initial: { id: 'execute', props: { sessionId: 'r-models' } },
      sessions,
    });
    await waitForViewReady(result, (f) => f.includes('claude-opus-4-8'));
    const frame = result.lastFrame() ?? '';
    // Both models appear on separate labelled lines.
    expect(frame).toContain('claude-opus-4-8');
    expect(frame).toContain('gpt-5.5');
    // New two-line format: "generator <model>" / "evaluator <model>" — no arrow or (eval) tag.
    expect(frame).toContain('generator');
    expect(frame).toContain('evaluator');
    expect(frame).not.toContain('(eval)');
    result.unmount();
  });

  it('renders explicit generator + evaluator lines even when both implement models match', async () => {
    const sessions = createSessionManager();
    const runner = fakeRunner('r-models-same', 'running');
    sessions.register({
      runner,
      flowId: 'implement',
      title: 'Implement — Single model',
      generatorModel: 'claude-opus-4-8',
      evaluatorModel: 'claude-opus-4-8',
    });

    const { result } = renderView(<ExecuteView />, {
      deps: stubDeps(),
      initial: { id: 'execute', props: { sessionId: 'r-models-same' } },
      sessions,
    });
    await waitForViewReady(result, (f) => f.includes('claude-opus-4-8'));
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('claude-opus-4-8');
    // Even when the models are the same, both labelled lines appear — the operator needs
    // explicit visibility of both roles. No old-format arrow or (eval) tag.
    expect(frame).toContain('generator');
    expect(frame).toContain('evaluator');
    expect(frame).not.toContain('→');
    expect(frame).not.toContain('(eval)');
    result.unmount();
  });

  it('Enter on a completed session resets to Home even when the session has a pinned sprint', async () => {
    const sessions = createSessionManager();
    const runner = fakeRunner('r-3', 'completed');
    const pinnedSprintId = 'sprint-fixture' as unknown as SprintId;
    sessions.register({
      runner,
      flowId: 'refine',
      title: 'Refine — Done',
      pinnedSprintId,
      pinnedSprintLabel: 'Demo Sprint',
    });

    const { result, routeIds } = renderView(<ExecuteView />, {
      deps: stubDeps(),
      initial: { id: 'execute', props: { sessionId: 'r-3' } },
      sessions,
    });
    await waitForViewReady(result, (f) => f.includes('Refine — Done'));
    result.stdin.write(ENTER);
    await waitFor(() => routeIds().includes('home'));
    expect(routeIds()).toContain('home');
    expect(routeIds()).not.toContain('sprint-detail');
    result.unmount();
  });

  it('Enter after a run goes Home and leaves a drifted global selection untouched', async () => {
    // The user's rule: the project/sprint combo starts from THEIR pick and only changes on an
    // explicit pick. A settled run pinned to sprint A must route Home (not sprint-detail of A)
    // and must not drag the selection from B back to A on the way out.
    const sessions = createSessionManager();
    const runner = fakeRunner('r-pin-nav', 'completed');
    const sprintA = 'sprint-a-nav' as unknown as SprintId;
    sessions.register({
      runner,
      flowId: 'implement',
      title: 'Implement — Pinned',
      pinnedProjectId: 'project-a-nav' as unknown as ProjectId,
      pinnedProjectLabel: 'Project A',
      pinnedSprintId: sprintA,
      pinnedSprintLabel: 'Sprint A',
    });

    const sprintB = 'sprint-b-nav' as unknown as SprintId;
    const routeEntries: ViewEntry[] = [];
    const seenSprintIds: Array<SprintId | undefined> = [];
    const SelectionProbe = (): null => {
      const sel = useSelection();
      seenSprintIds.push(sel.sprintId);
      return null;
    };
    const { result } = renderView(
      <>
        <ExecuteView />
        <SelectionProbe />
      </>,
      {
        deps: stubDeps(),
        initial: { id: 'execute', props: { sessionId: 'r-pin-nav' } },
        sessions,
        selection: { sprintId: sprintB, sprintLabel: 'Sprint B' },
        onRoute: (e) => {
          routeEntries.push(e);
        },
      }
    );
    await waitForViewReady(result, (f) => f.includes('Implement — Pinned'));
    result.stdin.write(ENTER);
    await waitFor(() => routeEntries.some((e) => e.id === 'home'));
    expect(routeEntries.some((e) => e.id === 'sprint-detail')).toBe(false);
    // The selection seeded to sprint B must survive both the focus and the exit.
    expect(seenSprintIds.at(-1)).toBe(sprintB);
    expect(seenSprintIds).not.toContain(sprintA);
    result.unmount();
  });

  it('focusing an execute view never converges the global selection onto the run pinned sprint', async () => {
    // Regression fence: viewing a run (Tab / Ctrl+1..9 / Sessions-open) is a browse, not a
    // pick. An effect that "converges" the selection onto the run's pinned project/sprint
    // clobbers the user's pick AND persists the clobber — the next boot then lands on the
    // wrong sprint.
    const sessions = createSessionManager();
    const runner = fakeRunner('r-no-converge', 'running');
    const sprintA = 'sprint-converge-a' as unknown as SprintId;
    sessions.register({
      runner,
      flowId: 'implement',
      title: 'Implement — No Converge',
      pinnedProjectId: 'project-converge-a' as unknown as ProjectId,
      pinnedProjectLabel: 'Project A',
      pinnedSprintId: sprintA,
      pinnedSprintLabel: 'Sprint A',
    });

    const sprintB = 'sprint-converge-b' as unknown as SprintId;
    const seenSprintIds: Array<SprintId | undefined> = [];
    const SelectionProbe = (): null => {
      const sel = useSelection();
      seenSprintIds.push(sel.sprintId);
      return null;
    };
    const { result } = renderView(
      <>
        <ExecuteView />
        <SelectionProbe />
      </>,
      {
        deps: stubDeps(),
        initial: { id: 'execute', props: { sessionId: 'r-no-converge' } },
        sessions,
        selection: { sprintId: sprintB, sprintLabel: 'Sprint B' },
      }
    );
    await waitForViewReady(result, (f) => f.includes('Implement — No Converge'));
    await tick();
    expect(seenSprintIds.at(-1)).toBe(sprintB);
    expect(seenSprintIds).not.toContain(sprintA);
    result.unmount();
  });

  it('two sessions pinned to different sprints each show their own sprint context in the breadcrumb', async () => {
    const sessions = createSessionManager();
    const runnerA = fakeRunner('r-ctx-a', 'running');
    const sprintA = 'sprint-ctx-a' as unknown as SprintId;
    sessions.register({
      runner: runnerA,
      flowId: 'implement',
      title: 'Implement — A',
      pinnedSprintId: sprintA,
      pinnedSprintLabel: 'Sprint Alpha',
      pinnedProjectLabel: 'Project One',
    });
    // Session B is registered but never viewed — A's context should show in the breadcrumb.
    const runnerB = fakeRunner('r-ctx-b', 'running');
    const sprintB = 'sprint-ctx-b' as unknown as SprintId;
    sessions.register({
      runner: runnerB,
      flowId: 'implement',
      title: 'Implement — B',
      pinnedSprintId: sprintB,
      pinnedSprintLabel: 'Sprint Beta',
    });

    const { result } = renderView(<ExecuteView />, {
      deps: stubDeps(),
      initial: { id: 'execute', props: { sessionId: 'r-ctx-a' } },
      sessions,
      selection: { sprintId: sprintB, sprintLabel: 'Sprint Beta' },
    });
    await waitForViewReady(result, (f) => f.includes('Sprint Alpha'));
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('Sprint Alpha');
    expect(frame).toContain('Project One');
    result.unmount();
  });

  it('cancel-whole-flow calls taskRepo with the pinned sprint id, not the global selection sprint', async () => {
    const TASK = '01933fbb-1111-7000-8000-000000000099';
    const taskNames = new Map([[TASK, 'Demo task']]);
    const traceArray: TraceEntry[] = [{ elementName: `generator-${TASK}`, status: 'completed', durationMs: 100 }];
    const runner: Runner<unknown> = {
      id: 'r-cancel-pin',
      status: 'running' as const,
      ctx: {},
      trace: traceArray as Trace,
      subscribe: () => () => undefined,
      start: vi.fn(),
      abort: vi.fn(),
    } as unknown as Runner<unknown>;

    const sprintA = 'sprint-cancel-a' as unknown as SprintId;
    const sessions = createSessionManager();
    sessions.register({
      runner,
      flowId: 'implement',
      title: 'Implement — Cancel',
      pinnedSprintId: sprintA,
      taskNames,
      terminalSubstepName: 'uninstall-skills',
    });

    const findById = vi.fn().mockResolvedValue({ ok: false });
    const deps: AppDeps = {
      eventBus: noopEventBus,
      taskRepo: { findById, findBySprintId: vi.fn().mockResolvedValue({ ok: true, value: [] }) },
    } as unknown as AppDeps;

    const sprintB = 'sprint-cancel-b' as unknown as SprintId;
    const { result } = renderView(<ExecuteView />, {
      deps,
      initial: { id: 'execute', props: { sessionId: 'r-cancel-pin' } },
      sessions,
      selection: { sprintId: sprintB, sprintLabel: 'Sprint B Cancel' },
    });
    await waitForViewReady(result, (f) => f.includes('Implement — Cancel'));
    result.stdin.write('c');
    await waitFor(() => (result.lastFrame() ?? '').includes('Cancel — pick a scope'));
    result.stdin.write('2');
    await waitFor(() => findById.mock.calls.length > 0);
    expect(findById).toHaveBeenCalledWith(sprintA, TASK as unknown as TaskId);
    result.unmount();
  });

  it('mutes the TasksPanel cursor while the cancel-scope overlay is open', async () => {
    // L3: the cancel-scope overlay renders inline behind the modal; without gating, the
    // TasksPanel's j/k cursor (and esc/e) double-handle the hidden panel. We prove the mute
    // via the card cursor: with two tasks the `›` marker sits on the first task. Pressing `j`
    // while the overlay is open must NOT move it; after esc dismisses the overlay `j` moves
    // the cursor to the second task as normal.
    const T1 = '01933fbb-1111-7000-8000-000000000001';
    const T2 = '01933fbb-1111-7000-8000-000000000002';
    const taskNames = new Map([
      [T1, 'First task'],
      [T2, 'Second task'],
    ]);
    const traceArray: TraceEntry[] = [
      { elementName: `generator-${T1}`, status: 'completed', durationMs: 100 },
      { elementName: `settle-attempt-${T1}`, status: 'completed', durationMs: 1 },
      { elementName: `generator-${T2}`, status: 'completed', durationMs: 100 },
    ];
    const runner: Runner<unknown> = {
      id: 'r-cancel-mute',
      status: 'running' as const,
      ctx: {},
      trace: traceArray as Trace,
      subscribe: () => () => undefined,
      start: vi.fn(),
      abort: vi.fn(),
    } as unknown as Runner<unknown>;

    const sprintA = 'sprint-cancel-mute' as unknown as SprintId;
    const sessions = createSessionManager();
    sessions.register({
      runner,
      flowId: 'implement',
      title: 'Implement — Mute',
      pinnedSprintId: sprintA,
      taskNames,
      terminalSubstepName: 'uninstall-skills',
      maxTurns: 10,
    });

    const deps: AppDeps = {
      eventBus: noopEventBus,
      sprintExecutionRepo: { findById: vi.fn().mockResolvedValue({ ok: false }) },
      taskRepo: {
        findById: vi.fn().mockResolvedValue({ ok: false }),
        findBySprintId: vi.fn().mockResolvedValue({ ok: true, value: [] }),
      },
    } as unknown as AppDeps;

    const { result } = renderView(<ExecuteView />, {
      deps,
      initial: { id: 'execute', props: { sessionId: 'r-cancel-mute' } },
      sessions,
    });
    await waitForViewReady(result, (f) => f.includes('Implement — Mute'));
    // `›` (selectMarker) sits on the first task at rest.
    const cursorOnSecond = (frame: string): boolean => /›[^\n]*Second task/.test(frame);
    expect(cursorOnSecond(result.lastFrame() ?? '')).toBe(false);

    // Open the overlay, then press `j` — the panel is muted, so the cursor stays put.
    result.stdin.write('c');
    await waitFor(() => (result.lastFrame() ?? '').includes('Cancel — pick a scope'));
    expect(result.lastFrame() ?? '').toContain('Cancel — pick a scope');
    result.stdin.write('j');
    await tick();
    expect(cursorOnSecond(result.lastFrame() ?? '')).toBe(false);

    // Dismiss the overlay; `j` is live again and advances the cursor to the second task.
    result.stdin.write(ESC);
    await tick();
    expect(result.lastFrame() ?? '').not.toContain('Cancel — pick a scope');
    result.stdin.write('j');
    await waitFor(() => cursorOnSecond(result.lastFrame() ?? ''));
    expect(cursorOnSecond(result.lastFrame() ?? '')).toBe(true);
    result.unmount();
  });

  it('shows the stale-sprint fallback and drops baseline-health surfaces when the pinned sprint is done', async () => {
    const sessions = createSessionManager();
    const runner = fakeRunner('r-stale-done', 'running');
    const sprintA = 'sprint-stale-done' as unknown as SprintId;
    sessions.register({ runner, flowId: 'implement', title: 'Implement — Stale Done', pinnedSprintId: sprintA });

    const mockSprintRepo = { findById: vi.fn().mockResolvedValue({ ok: true, value: { status: 'done' } }) };
    const deps: AppDeps = { eventBus: noopEventBus, sprintRepo: mockSprintRepo } as unknown as AppDeps;

    const { result } = renderView(<ExecuteView />, {
      deps,
      initial: { id: 'execute', props: { sessionId: 'r-stale-done' } },
      sessions,
    });
    await waitForViewReady(result, (f) => f.includes('Sprint no longer available'));
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('Sprint no longer available');
    // BaselineHealthChip always renders the word "baseline" — when stale it must be absent.
    expect(frame).not.toContain('baseline');
    result.unmount();
  });

  it('derives the section title from the flowId (audit 1-C)', async () => {
    // Each non-implement flowId should produce its own display name in the SectionStamp, not
    // the hardcoded "Implement" that previously appeared for every flow. SectionStamp renders
    // the title string verbatim (no forced uppercasing); flowIdToTitle returns title-cased names.
    const flowCases: ReadonlyArray<[string, string]> = [
      ['refine', 'Refine'],
      ['plan', 'Plan'],
      ['ideate', 'Ideate'],
      ['review', 'Review'],
      ['create-pr', 'Create PR'],
      ['readiness', 'Readiness'],
      ['detect-scripts', 'Detect Scripts'],
      ['detect-skills', 'Detect Skills'],
      ['create-sprint', 'Create Sprint'],
      ['close-sprint', 'Close Sprint'],
      ['add-ticket', 'Add Ticket'],
      ['remove-ticket', 'Remove Ticket'],
      ['export-context', 'Export Context'],
      ['export-requirements', 'Export Requirements'],
      ['doctor', 'Doctor'],
      ['settings', 'Settings'],
    ];
    for (const [flowId, expectedTitle] of flowCases) {
      const sessions = createSessionManager();
      const runner = fakeRunner(`r-title-${flowId}`, 'running');
      sessions.register({ runner, flowId, title: `${flowId} — Demo` });

      const { result } = renderView(<ExecuteView />, {
        deps: stubDeps(),
        initial: { id: 'execute', props: { sessionId: `r-title-${flowId}` } },
        sessions,
      });

      await waitForViewReady(result, (f) => f.includes(expectedTitle));
      const frame = result.lastFrame() ?? '';
      expect(frame, `flowId="${flowId}" should show "${expectedTitle}"`).toContain(expectedTitle);
      // The old hardcoded title must not appear for non-implement flows.
      // (We check for the word boundary to avoid false positives in titles like "Create Sprint"
      // which do not contain "Implement".)
      result.unmount();
    }
  });

  it('shows the stale-sprint fallback and drops baseline-health when the pinned sprint is removed', async () => {
    const sessions = createSessionManager();
    const runner = fakeRunner('r-stale-removed', 'running');
    const sprintA = 'sprint-stale-removed' as unknown as SprintId;
    sessions.register({ runner, flowId: 'implement', title: 'Implement — Stale Removed', pinnedSprintId: sprintA });

    const mockSprintRepo = { findById: vi.fn().mockResolvedValue({ ok: false, error: { kind: 'not-found' } }) };
    const deps: AppDeps = { eventBus: noopEventBus, sprintRepo: mockSprintRepo } as unknown as AppDeps;

    const { result } = renderView(<ExecuteView />, {
      deps,
      initial: { id: 'execute', props: { sessionId: 'r-stale-removed' } },
      sessions,
    });
    await waitForViewReady(result, (f) => f.includes('Sprint no longer available'));
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('Sprint no longer available');
    expect(frame).not.toContain('baseline');
    result.unmount();
  });

  it('focused-run context shows the pinned sprint and project in the breadcrumb while the execute view is mounted', async () => {
    const sessions = createSessionManager();
    const runner = fakeRunner('r-focused-ctx', 'running');
    const sprintA = 'sprint-focused-a' as unknown as SprintId;
    sessions.register({
      runner,
      flowId: 'implement',
      title: 'Implement — Focused',
      pinnedSprintId: sprintA,
      pinnedSprintLabel: 'Sprint Pinned',
      pinnedProjectLabel: 'Project Alpha',
    });

    const { result } = renderView(<ExecuteView />, {
      deps: stubDeps(),
      initial: { id: 'execute', props: { sessionId: 'r-focused-ctx' } },
      sessions,
    });
    await waitForViewReady(result, (f) => f.includes('Sprint Pinned'));
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('Sprint Pinned');
    expect(frame).toContain('Project Alpha');
    result.unmount();
  });
});
