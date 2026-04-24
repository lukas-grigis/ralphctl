/**
 * RunningExecutionsView tests — verify registry subscription, selection,
 * Enter navigation, and X cancellation. Follows the ink-testing-library
 * pattern used by dashboard-view.test.tsx.
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import type {
  ExecutionRegistryPort,
  ExecutionStatus,
  RunningExecution,
} from '@src/business/ports/execution-registry.ts';
import type { Sprint } from '@src/domain/models.ts';
import { RouterProvider, type RouterApi } from './router-context.ts';
import { ViewHintsProvider } from './view-hints-context.tsx';
import type { SharedDeps } from '@src/integration/shared-deps.ts';

const routerPushMock = vi.fn();
const routerPopMock = vi.fn();
const routerReplaceMock = vi.fn();
const routerResetMock = vi.fn();

function makeRouterApi(): RouterApi {
  return {
    current: { id: 'running-executions' },
    stack: [{ id: 'home' }, { id: 'running-executions' }],
    push: routerPushMock,
    pop: routerPopMock,
    replace: routerReplaceMock,
    reset: routerResetMock,
  };
}

function makeSprint(id: string, name: string): Sprint {
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

function makeExecution(
  id: string,
  projectName: string,
  sprintId: string,
  sprintName: string,
  status: ExecutionStatus,
  startedAt: Date
): RunningExecution {
  return {
    id,
    projectName,
    sprintId,
    sprint: makeSprint(sprintId, sprintName),
    status,
    startedAt,
  };
}

interface StubRegistry extends ExecutionRegistryPort {
  emitTransition: (execution: RunningExecution) => void;
  setList: (executions: readonly RunningExecution[]) => void;
}

function makeStubRegistry(initial: readonly RunningExecution[] = []): StubRegistry {
  let executions = [...initial];
  const listeners = new Set<(e: RunningExecution) => void>();
  const cancelMock = vi.fn();

  const registry: StubRegistry = {
    start: vi.fn(() => Promise.reject(new Error('not used in tests'))),
    get: (id: string) => executions.find((e) => e.id === id) ?? null,
    list: () => executions.slice(),
    cancel: (id: string) => {
      cancelMock(id);
      const idx = executions.findIndex((e) => e.id === id);
      if (idx < 0) return;
      const e = executions[idx];
      if (!e) return;
      const next: RunningExecution = { ...e, status: 'cancelled', endedAt: new Date() };
      executions[idx] = next;
      for (const listener of listeners) listener(next);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSignalBus: () => null,
    getLogEventBus: () => null,
    emitTransition: (execution: RunningExecution) => {
      const idx = executions.findIndex((e) => e.id === execution.id);
      if (idx >= 0) executions[idx] = execution;
      else executions = [...executions, execution];
      for (const listener of listeners) listener(execution);
    },
    setList: (list: readonly RunningExecution[]) => {
      executions = [...list];
    },
  };
  // Expose the cancel mock for assertions via a property cast (keeps the port
  // surface clean while allowing assertions on call arguments).
  (registry as StubRegistry & { cancelMock: ReturnType<typeof vi.fn> }).cancelMock = cancelMock;
  return registry;
}

let currentRegistry: StubRegistry = makeStubRegistry();

vi.mock('@src/integration/bootstrap.ts', () => ({
  getSharedDeps: (): SharedDeps => ({ executionRegistry: currentRegistry }) as unknown as SharedDeps,
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

// Silence the global hotkey handler for these view-only tests — we never
// mount a full router, and the hook otherwise tries to resolve useApp().
vi.mock('@src/integration/ui/prompts/hooks.ts', () => ({
  useCurrentPrompt: () => null,
}));

import { RunningExecutionsView } from './running-executions-view.tsx';

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

describe('RunningExecutionsView', () => {
  afterEach(() => {
    vi.clearAllMocks();
    currentRegistry = makeStubRegistry();
  });

  it('renders the empty state when the registry has no executions', async () => {
    currentRegistry = makeStubRegistry([]);
    const { lastFrame } = renderWithRouter(<RunningExecutionsView />);
    await flush();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('No backgrounded executions');
  });

  it('renders one row per execution with project, sprint and status', async () => {
    const startedAt = new Date(Date.now() - 30_000);
    currentRegistry = makeStubRegistry([
      makeExecution('exec-1', 'alpha-proj', 'sprint-a', 'Alpha Sprint', 'running', startedAt),
      makeExecution('exec-2', 'beta-proj', 'sprint-b', 'Beta Sprint', 'completed', startedAt),
    ]);

    const { lastFrame } = renderWithRouter(<RunningExecutionsView />);
    await flush();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('alpha-proj');
    expect(frame).toContain('Alpha Sprint');
    expect(frame).toContain('beta-proj');
    expect(frame).toContain('Beta Sprint');
    expect(frame).toContain('[RUNNING]');
    expect(frame).toContain('[COMPLETED]');
  });

  it('Enter on a row pushes the execute view with the executionId', async () => {
    currentRegistry = makeStubRegistry([makeExecution('exec-1', 'alpha', 'sprint-a', 'Alpha', 'running', new Date())]);

    const { stdin } = renderWithRouter(<RunningExecutionsView />);
    await flush();

    stdin.write('\r');
    await flush();

    expect(routerPushMock).toHaveBeenCalledWith({
      id: 'execute',
      props: { sprintId: 'sprint-a', executionId: 'exec-1' },
    });
  });

  it('X cancels the highlighted running execution', async () => {
    const registry = makeStubRegistry([makeExecution('exec-1', 'alpha', 'sprint-a', 'Alpha', 'running', new Date())]);
    currentRegistry = registry;

    const { stdin } = renderWithRouter(<RunningExecutionsView />);
    await flush();

    stdin.write('X');
    await flush();

    const cancelSpy = (registry as StubRegistry & { cancelMock: ReturnType<typeof vi.fn> }).cancelMock;
    expect(cancelSpy).toHaveBeenCalledWith('exec-1');
  });

  it('X is a no-op on a terminal row', async () => {
    const registry = makeStubRegistry([makeExecution('exec-1', 'alpha', 'sprint-a', 'Alpha', 'completed', new Date())]);
    currentRegistry = registry;

    const { stdin } = renderWithRouter(<RunningExecutionsView />);
    await flush();

    stdin.write('X');
    await flush();

    const cancelSpy = (registry as StubRegistry & { cancelMock: ReturnType<typeof vi.fn> }).cancelMock;
    expect(cancelSpy).not.toHaveBeenCalled();
  });

  it('re-renders when the registry emits a new transition', async () => {
    const registry = makeStubRegistry([]);
    currentRegistry = registry;

    const { lastFrame } = renderWithRouter(<RunningExecutionsView />);
    await flush();
    expect(lastFrame() ?? '').toContain('No backgrounded executions');

    registry.emitTransition(makeExecution('exec-1', 'alpha', 'sprint-a', 'Alpha Sprint', 'running', new Date()));
    await flush();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('alpha');
    expect(frame).toContain('Alpha Sprint');
    expect(frame).toContain('[RUNNING]');
  });
});
