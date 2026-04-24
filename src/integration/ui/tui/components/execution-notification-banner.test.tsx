/**
 * ExecutionNotificationBanner tests — verify the toast appears on a fresh
 * terminal transition for an unvisited execution, and that cancelled entries
 * never surface a success toast.
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

function makeExecution(id: string, projectName: string, sprintName: string, status: ExecutionStatus): RunningExecution {
  return {
    id,
    projectName,
    sprintId: `sprint-${id}`,
    sprint: makeSprint(`sprint-${id}`, sprintName),
    status,
    startedAt: new Date(Date.now() - 60_000),
  };
}

interface StubRegistry extends ExecutionRegistryPort {
  emitTransition: (execution: RunningExecution) => void;
}

function makeStubRegistry(initial: readonly RunningExecution[] = []): StubRegistry {
  let executions = [...initial];
  const listeners = new Set<(e: RunningExecution) => void>();
  return {
    start: vi.fn(() => Promise.reject(new Error('not used'))),
    get: (id: string) => executions.find((e) => e.id === id) ?? null,
    list: () => executions.slice(),
    cancel: vi.fn(),
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
  };
}

import { ExecutionNotificationBanner } from './execution-notification-banner.tsx';

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe('ExecutionNotificationBanner', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing when no registry is supplied', () => {
    const { lastFrame } = render(<ExecutionNotificationBanner currentViewId="home" registry={null} />);
    expect(lastFrame() ?? '').toBe('');
  });

  it('renders nothing when no execution has settled', async () => {
    const registry = makeStubRegistry([makeExecution('exec-1', 'alpha', 'Alpha Sprint', 'running')]);
    const { lastFrame } = render(<ExecutionNotificationBanner currentViewId="home" registry={registry} />);
    await flush();
    expect(lastFrame() ?? '').not.toContain('alpha');
  });

  it('shows a toast when a running execution transitions to completed', async () => {
    const registry = makeStubRegistry([makeExecution('exec-1', 'alpha', 'Alpha Sprint', 'running')]);

    const { lastFrame, rerender } = render(<ExecutionNotificationBanner currentViewId="home" registry={registry} />);
    await flush();
    expect(lastFrame() ?? '').not.toContain('Alpha Sprint');

    registry.emitTransition(makeExecution('exec-1', 'alpha', 'Alpha Sprint', 'completed'));
    await flush();
    // Force a re-render to pick up the state transition dispatched from the
    // subscribe listener — ink-testing-library does not auto-re-render
    // after imperative registry state changes.
    rerender(<ExecutionNotificationBanner currentViewId="home" registry={registry} />);
    await flush();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('alpha');
    expect(frame).toContain('Alpha Sprint');
    expect(frame).toContain('DONE');
  });

  it('shows a failure toast when a running execution transitions to failed', async () => {
    const registry = makeStubRegistry([makeExecution('exec-2', 'beta', 'Beta Sprint', 'running')]);

    const { lastFrame, rerender } = render(<ExecutionNotificationBanner currentViewId="home" registry={registry} />);
    await flush();

    registry.emitTransition(makeExecution('exec-2', 'beta', 'Beta Sprint', 'failed'));
    await flush();
    rerender(<ExecutionNotificationBanner currentViewId="home" registry={registry} />);
    await flush();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('beta');
    expect(frame).toContain('Beta Sprint');
    expect(frame).toContain('FAILED');
  });

  it('never surfaces a toast for a cancelled execution', async () => {
    const registry = makeStubRegistry([makeExecution('exec-3', 'gamma', 'Gamma Sprint', 'running')]);

    const { lastFrame } = render(<ExecutionNotificationBanner currentViewId="home" registry={registry} />);
    await flush();

    registry.emitTransition(makeExecution('exec-3', 'gamma', 'Gamma Sprint', 'cancelled'));
    await flush();

    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('Gamma Sprint');
    expect(frame).not.toContain('DONE');
  });

  it('suppresses the toast when the user is already on the running-executions view', async () => {
    const registry = makeStubRegistry([makeExecution('exec-4', 'delta', 'Delta Sprint', 'completed')]);

    const { lastFrame } = render(
      <ExecutionNotificationBanner currentViewId="running-executions" registry={registry} />
    );
    await flush();

    expect(lastFrame() ?? '').not.toContain('Delta Sprint');
  });
});
