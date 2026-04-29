/**
 * ExecutionNotificationBanner tests — verify the tracker publishes to the
 * shared notification bus on a fresh terminal transition for an unvisited
 * execution, and that cancelled / already-visited entries never surface.
 *
 * The component itself renders nothing (returns null); the visible surface
 * is `<StickyNotification />`, exercised in its own test file.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import type {
  ExecutionRegistryPort,
  ExecutionStatus,
  RunningExecution,
} from '@src/business/ports/execution-registry.ts';
import type { Sprint } from '@src/domain/models.ts';
import { notificationBus } from '@src/integration/ui/tui/runtime/notification-bus.ts';

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
  beforeEach(() => {
    // Drop any notification leftover from a prior test — the bus is a
    // module singleton so cross-test cleanup is the caller's responsibility.
    const active = notificationBus.current();
    if (active !== null) notificationBus.clear(active.id);
  });

  afterEach(() => {
    vi.clearAllMocks();
    const active = notificationBus.current();
    if (active !== null) notificationBus.clear(active.id);
  });

  it('publishes nothing when no registry is supplied', async () => {
    render(<ExecutionNotificationBanner currentViewId="home" registry={null} />);
    await flush();
    expect(notificationBus.current()).toBeNull();
  });

  it('publishes nothing while every execution is still running', async () => {
    const registry = makeStubRegistry([makeExecution('exec-1', 'alpha', 'Alpha Sprint', 'running')]);
    render(<ExecutionNotificationBanner currentViewId="home" registry={registry} />);
    await flush();
    expect(notificationBus.current()).toBeNull();
  });

  it('publishes a success notification when a running execution transitions to completed', async () => {
    const registry = makeStubRegistry([makeExecution('exec-1', 'alpha', 'Alpha Sprint', 'running')]);

    const { rerender } = render(<ExecutionNotificationBanner currentViewId="home" registry={registry} />);
    await flush();
    expect(notificationBus.current()).toBeNull();

    registry.emitTransition(makeExecution('exec-1', 'alpha', 'Alpha Sprint', 'completed'));
    await flush();
    rerender(<ExecutionNotificationBanner currentViewId="home" registry={registry} />);
    await flush();

    const active = notificationBus.current();
    expect(active).not.toBeNull();
    expect(active?.id).toBe('execution-exec-1');
    expect(active?.status).toBe('success');
    expect(active?.message).toContain('alpha');
    expect(active?.message).toContain('Alpha Sprint');
    expect(active?.message).toContain('DONE');
    expect(active?.action?.key).toBe('x');
  });

  it('publishes a failure notification when a running execution transitions to failed', async () => {
    const registry = makeStubRegistry([makeExecution('exec-2', 'beta', 'Beta Sprint', 'running')]);

    const { rerender } = render(<ExecutionNotificationBanner currentViewId="home" registry={registry} />);
    await flush();

    registry.emitTransition(makeExecution('exec-2', 'beta', 'Beta Sprint', 'failed'));
    await flush();
    rerender(<ExecutionNotificationBanner currentViewId="home" registry={registry} />);
    await flush();

    const active = notificationBus.current();
    expect(active).not.toBeNull();
    expect(active?.status).toBe('error');
    expect(active?.message).toContain('FAILED');
  });

  it('never publishes for a cancelled execution', async () => {
    const registry = makeStubRegistry([makeExecution('exec-3', 'gamma', 'Gamma Sprint', 'running')]);

    render(<ExecutionNotificationBanner currentViewId="home" registry={registry} />);
    await flush();

    registry.emitTransition(makeExecution('exec-3', 'gamma', 'Gamma Sprint', 'cancelled'));
    await flush();

    expect(notificationBus.current()).toBeNull();
  });

  it('does not publish when the user is already on the running-executions view', async () => {
    const registry = makeStubRegistry([makeExecution('exec-4', 'delta', 'Delta Sprint', 'completed')]);

    render(<ExecutionNotificationBanner currentViewId="running-executions" registry={registry} />);
    await flush();

    expect(notificationBus.current()).toBeNull();
  });

  it('clears any matching active notification when the user lands on the runs list', async () => {
    const registry = makeStubRegistry([makeExecution('exec-5', 'epsilon', 'Eps Sprint', 'running')]);

    const { rerender } = render(<ExecutionNotificationBanner currentViewId="home" registry={registry} />);
    await flush();

    registry.emitTransition(makeExecution('exec-5', 'epsilon', 'Eps Sprint', 'completed'));
    await flush();
    rerender(<ExecutionNotificationBanner currentViewId="home" registry={registry} />);
    await flush();
    expect(notificationBus.current()).not.toBeNull();

    rerender(<ExecutionNotificationBanner currentViewId="running-executions" registry={registry} />);
    await flush();

    expect(notificationBus.current()).toBeNull();
  });
});
