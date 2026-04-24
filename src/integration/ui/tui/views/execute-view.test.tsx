/**
 * ExecuteView tests — verify the reducer translates HarnessEvents into view
 * state, plus the attach/start behaviour against the execution registry:
 *
 *   - Attach-by-id path when the router supplies an existing `executionId`
 *   - Start-collision redirect on `ExecutionAlreadyRunningError`
 *   - `c` binding cancels a running execution via the registry
 *
 * The rendering-focused cases use ink-testing-library and stub the registry
 * surface so we never spin up a real pipeline.
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import type { HarnessEvent, SignalBusPort } from '@src/business/ports/signal-bus.ts';
import type {
  ExecutionRegistryPort,
  ExecutionStatus,
  RunningExecution,
  StartExecutionParams,
} from '@src/business/ports/execution-registry.ts';
import { ExecutionAlreadyRunningError } from '@src/domain/errors.ts';
import type { Sprint, Task } from '@src/domain/models.ts';
import type { SharedDeps } from '@src/integration/shared-deps.ts';
import { NoopSignalBus } from '@src/integration/signals/bus.ts';
import { RouterProvider, type RouterApi } from './router-context.ts';
import { ViewHintsProvider } from './view-hints-context.tsx';

const routerPushMock = vi.fn();
const routerPopMock = vi.fn();
const routerReplaceMock = vi.fn();
const routerResetMock = vi.fn();

function makeRouterApi(currentId: RouterApi['current']['id'] = 'execute'): RouterApi {
  return {
    current: { id: currentId },
    stack: [{ id: 'home' }, { id: currentId }],
    push: routerPushMock,
    pop: routerPopMock,
    replace: routerReplaceMock,
    reset: routerResetMock,
  };
}

function makeSprint(id: string, name = 'Sprint'): Sprint {
  return {
    id,
    name,
    projectId: 'prj00001',
    status: 'active',
    createdAt: '2026-04-20T00:00:00Z',
    activatedAt: '2026-04-20T00:00:00Z',
    closedAt: null,
    tickets: [],
    checkRanAt: {},
    branch: null,
  };
}

function makeExecution(id: string, sprintId: string, status: ExecutionStatus = 'running'): RunningExecution {
  return {
    id,
    projectName: 'alpha',
    sprintId,
    sprint: makeSprint(sprintId, 'Alpha Sprint'),
    status,
    startedAt: new Date(Date.now() - 30_000),
  };
}

interface StubRegistry extends ExecutionRegistryPort {
  setEntry: (execution: RunningExecution | null) => void;
  cancelCalls: string[];
  startCalls: StartExecutionParams[];
  signalBus: SignalBusPort;
}

function makeStubRegistry(options: {
  entry?: RunningExecution | null;
  startImpl?: (params: StartExecutionParams) => Promise<RunningExecution>;
}): StubRegistry {
  let entry: RunningExecution | null = options.entry ?? null;
  const listeners = new Set<(e: RunningExecution) => void>();
  const cancelCalls: string[] = [];
  const startCalls: StartExecutionParams[] = [];
  const signalBus = new NoopSignalBus();

  const registry: StubRegistry = {
    start: vi.fn(async (params: StartExecutionParams) => {
      startCalls.push(params);
      if (options.startImpl) return options.startImpl(params);
      throw new Error('no startImpl provided');
    }),
    get: (id: string) => (entry?.id === id ? entry : null),
    list: () => (entry ? [entry] : []),
    cancel: (id: string) => {
      cancelCalls.push(id);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSignalBus: () => signalBus,
    getLogEventBus: () => null,
    setEntry: (next) => {
      entry = next;
      if (next) {
        for (const l of listeners) l(next);
      }
    },
    cancelCalls,
    startCalls,
    signalBus,
  };
  return registry;
}

let currentRegistry: StubRegistry = makeStubRegistry({});

const persistenceStub = {
  getTasks: vi.fn((): Promise<readonly Task[]> => Promise.resolve([])),
  getSprint: vi.fn((id: string) => Promise.resolve(makeSprint(id))),
};

vi.mock('@src/integration/bootstrap.ts', () => ({
  getSharedDeps: (): SharedDeps =>
    ({
      executionRegistry: currentRegistry,
      persistence: persistenceStub,
    }) as unknown as SharedDeps,
  getPrompt: () => ({
    select: vi.fn(),
    confirm: vi.fn(),
    input: vi.fn(),
    checkbox: vi.fn(),
    editor: vi.fn(),
    fileBrowser: vi.fn(),
  }),
  setSharedDeps: vi.fn(),
}));

vi.mock('@src/integration/persistence/task.ts', () => ({
  areAllTasksDone: vi.fn(() => Promise.resolve(false)),
}));

vi.mock('@src/integration/persistence/sprint.ts', () => ({
  closeSprint: vi.fn(),
}));

vi.mock('@src/integration/ui/prompts/hooks.ts', () => ({
  useCurrentPrompt: () => null,
}));

import { initialState, reduceEvents, ExecuteView, buildErrorCard } from './execute-view.tsx';

function renderWithRouter(element: React.ReactElement): ReturnType<typeof render> {
  return render(
    <RouterProvider value={makeRouterApi()}>
      <ViewHintsProvider>{element}</ViewHintsProvider>
    </RouterProvider>
  );
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe('reduceEvents', () => {
  it('adds task-started ids to the running set', () => {
    const state = initialState();
    const events: HarnessEvent[] = [
      { type: 'task-started', sprintId: 's1', taskId: 't1', taskName: 'Alpha', timestamp: new Date() },
    ];
    const next = reduceEvents(state, events);
    expect(next.running.has('t1')).toBe(true);
  });

  it('removes task-finished ids from running and records blocked/failed', () => {
    const started = reduceEvents(initialState(), [
      { type: 'task-started', sprintId: 's1', taskId: 't1', taskName: 'Alpha', timestamp: new Date() },
    ]);
    const finished = reduceEvents(started, [
      { type: 'task-finished', sprintId: 's1', taskId: 't1', status: 'blocked', timestamp: new Date() },
    ]);
    expect(finished.running.has('t1')).toBe(false);
    expect(finished.blocked.has('t1')).toBe(true);
  });

  it('updates activity map from progress signals', () => {
    const next = reduceEvents(initialState(), [
      {
        type: 'signal',
        ctx: { sprintId: 's1', taskId: 't1' },
        signal: { type: 'progress', summary: 'wrote index.ts', timestamp: new Date() },
      },
    ]);
    expect(next.activity.get('t1')).toBe('wrote index.ts');
  });

  it('sets rateLimit on pause and clears it on resume', () => {
    const paused = reduceEvents(initialState(), [
      { type: 'rate-limit-paused', delayMs: 30_000, timestamp: new Date() },
    ]);
    expect(paused.rateLimit).not.toBeNull();
    expect(paused.rateLimit?.delayMs).toBe(30_000);

    const resumed = reduceEvents(paused, [{ type: 'rate-limit-resumed', timestamp: new Date() }]);
    expect(resumed.rateLimit).toBeNull();
  });
});

describe('ExecuteView — attach / start behaviour', () => {
  afterEach(() => {
    vi.clearAllMocks();
    currentRegistry = makeStubRegistry({});
  });

  it('attaches to an existing execution when given an executionId', async () => {
    const existing = makeExecution('exec-1', 'sprint-a', 'running');
    currentRegistry = makeStubRegistry({ entry: existing });

    const { lastFrame, rerender } = renderWithRouter(<ExecuteView sprintId="sprint-a" executionId="exec-1" />);
    // Multiple flushes + rerender let the attach effect, sprint-loading
    // effect, and subsequent state updates all settle before we assert.
    await flush();
    await flush();
    rerender(
      <RouterProvider value={makeRouterApi()}>
        <ViewHintsProvider>
          <ExecuteView sprintId="sprint-a" executionId="exec-1" />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await flush();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Alpha Sprint');
    expect(currentRegistry.startCalls).toHaveLength(0);
  });

  it('renders a collision card and replaces the frame on Enter when start throws', async () => {
    const startImpl = (): Promise<RunningExecution> => {
      return Promise.reject(new ExecutionAlreadyRunningError('alpha', 'exec-existing'));
    };
    currentRegistry = makeStubRegistry({ startImpl });

    const { lastFrame, stdin } = renderWithRouter(<ExecuteView sprintId="sprint-a" />);
    await flush();
    await flush();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Execution already running');

    stdin.write('\r');
    await flush();

    expect(routerReplaceMock).toHaveBeenCalledWith({
      id: 'execute',
      props: { sprintId: 'sprint-a', executionId: 'exec-existing' },
    });
  });

  it('pressing `c` while running cancels via the registry', async () => {
    const existing = makeExecution('exec-cancel', 'sprint-c', 'running');
    currentRegistry = makeStubRegistry({ entry: existing });

    const { stdin } = renderWithRouter(<ExecuteView sprintId="sprint-c" executionId="exec-cancel" />);
    await flush();

    stdin.write('c');
    await flush();

    expect(currentRegistry.cancelCalls).toContain('exec-cancel');
  });

  it('renders the failure reason when attaching to a failed execution', async () => {
    const failed: RunningExecution = {
      ...makeExecution('exec-fail', 'sprint-f', 'failed'),
      endedAt: new Date(),
      error: { message: 'sprint not found: sprint-f', stepName: 'load-sprint' },
    };
    currentRegistry = makeStubRegistry({ entry: failed });

    const { lastFrame } = renderWithRouter(<ExecuteView sprintId="sprint-f" executionId="exec-fail" />);
    await flush();
    await flush();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Execution failed');
    expect(frame).toContain('sprint not found: sprint-f');
    expect(frame).toContain('load-sprint');
  });

  it('renders the log tail before the failure card so the card is pinned at the bottom', async () => {
    const failed: RunningExecution = {
      ...makeExecution('exec-order', 'sprint-o', 'failed'),
      endedAt: new Date(),
      error: { message: 'build failed', stepName: 'run-check-scripts' },
    };
    currentRegistry = makeStubRegistry({ entry: failed });

    const { lastFrame } = renderWithRouter(<ExecuteView sprintId="sprint-o" executionId="exec-order" />);
    await flush();
    await flush();

    const frame = lastFrame() ?? '';
    const errorIdx = frame.indexOf('Execution failed');
    const logIdx = frame.indexOf('── Log');
    // The log header must appear BEFORE the ResultCard title in the rendered
    // output — this ensures the error card is pinned at the bottom of the
    // viewport, not buried in terminal scrollback by a long log tail.
    expect(errorIdx).toBeGreaterThanOrEqual(0);
    expect(logIdx).toBeGreaterThanOrEqual(0);
    expect(logIdx).toBeLessThan(errorIdx);
  });

  it('does not expose PgUp/PgDn/g/G scroll keys', () => {
    // The hints arrays are module-level constants — we verify they contain
    // only the keys the user asked to keep (c and Enter).
    // We import the view file itself to check, but the simplest verification
    // is that no hint entry in either hints set mentions those keys.
    // Since the constants are not exported we read the rendered frame instead.
    const running = makeExecution('exec-hints', 'sprint-h', 'running');
    currentRegistry = makeStubRegistry({ entry: running });

    const { lastFrame } = renderWithRouter(<ExecuteView sprintId="sprint-h" executionId="exec-hints" />);
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('PgUp');
    expect(frame).not.toContain('PgDn');
    // 'g' and 'G' as single-key bindings won't appear in the hint footer.
    expect(frame).not.toContain('log top');
    expect(frame).not.toContain('log bottom');
  });
});

describe('buildErrorCard', () => {
  it('returns all lines when message is short', () => {
    const { lines, fields } = buildErrorCard({ message: 'line one\nline two', stepName: 'my-step' });
    expect(lines).toEqual(['line one', 'line two']);
    expect(fields).toEqual([['Step', 'my-step']]);
  });

  it('keeps the last 20 lines and prepends an omission marker — build-tool errors report at the tail', () => {
    const longMessage = Array.from({ length: 30 }, (_, i) => `line ${String(i + 1)}`).join('\n');
    const { lines } = buildErrorCard({ message: longMessage });
    // Should have 1 omission marker + 20 content lines = 21 entries
    expect(lines).toHaveLength(21);
    expect(lines[0]).toContain('10 earlier line');
    expect(lines[0]).toContain('omitted');
    // First retained content line is line 11 (lines 1–10 dropped).
    expect(lines[1]).toBe('line 11');
    expect(lines[lines.length - 1]).toBe('line 30');
  });

  it('returns undefined fields when stepName is absent', () => {
    const { fields } = buildErrorCard({ message: 'oops' });
    expect(fields).toBeUndefined();
  });
});
