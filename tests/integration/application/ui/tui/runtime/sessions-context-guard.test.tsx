/**
 * Status-diff guard on `useSessions` / `useSession`. The session manager fires `notify()` on
 * every chain `step` (trace-only); the always-mounted StatusBar consumes these hooks, so an
 * unguarded subscription re-rendered once per leaf step — a log-floor-INDEPENDENT commit
 * amplifier. The guard must swallow trace-only notifies and only `setState` when a status (or
 * error presence) actually changed.
 *
 * We drive a controllable fake SessionManager so the test can fire N trace-only notifies then ONE
 * status change with deterministic timing, and count consumer renders via a ref.
 */

import React from 'react';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { describe, expect, it } from 'vitest';
import { SessionsProvider, useSession, useSessions } from '@src/application/ui/tui/runtime/sessions-context.tsx';
import type {
  SessionDescriptor,
  SessionListener,
  SessionManager,
  SessionRecord,
} from '@src/application/ui/tui/runtime/session-manager.ts';
import type { RunnerStatus } from '@src/application/chain/run/runner.ts';
import type { Runner } from '@src/application/chain/run/runner.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';

const drain = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

/**
 * Minimal controllable SessionManager: one record, mutable status + trace-version, and a single
 * listener set. `bumpTrace()` models a `step` (trace changes, status does not); `setStatus` models
 * a real transition. Both call `notify()`.
 */
const createFakeManager = (id: string) => {
  let status: RunnerStatus = 'running';
  let traceVersion = 0;
  let pinnedSprintId: SprintId | undefined;
  let pinnedSprintLabel: string | undefined;
  const listeners = new Set<SessionListener>();

  const recordOf = (): SessionRecord => {
    const descriptor = {
      id,
      flowId: 'demo',
      title: 'Demo',
      status,
      startedAt: 0,
      // `trace` is opaque to the hooks; we only need a fresh ref so a status-blind consumer
      // would see "something changed".
      trace: [{ v: traceVersion }] as unknown as SessionDescriptor['trace'],
      ...(pinnedSprintId !== undefined ? { pinnedSprintId } : {}),
      ...(pinnedSprintLabel !== undefined ? { pinnedSprintLabel } : {}),
    } satisfies SessionDescriptor;
    return { descriptor, runner: {} as Runner<unknown> };
  };

  const notify = (): void => {
    for (const fn of [...listeners]) fn();
  };

  const mgr: SessionManager = {
    list: () => [recordOf()],
    get: (lookup) => (lookup === id ? recordOf() : undefined),
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    register: () => recordOf(),
    abort: () => undefined,
    remove: () => undefined,
    setPinnedSprint: (_runnerId, sprintId, sprintLabel): void => {
      pinnedSprintId = sprintId;
      pinnedSprintLabel = sprintLabel;
      notify();
    },
  };

  return {
    mgr,
    bumpTrace: (): void => {
      traceVersion += 1;
      notify();
    },
    setStatus: (next: RunnerStatus): void => {
      status = next;
      notify();
    },
  };
};

describe('sessions-context status-diff guard', () => {
  it('useSessions: ignores trace-only step notifies, re-renders once on a status change', async () => {
    const fake = createFakeManager('s-1');
    let renders = 0;
    const Probe = (): React.JSX.Element => {
      const sessions = useSessions();
      renders += 1;
      return <Text>{sessions[0]?.descriptor.status ?? 'none'}</Text>;
    };
    const r = render(
      <SessionsProvider value={fake.mgr}>
        <Probe />
      </SessionsProvider>
    );
    await drain(5);
    const baseline = renders;

    // 20 trace-only notifies → zero consumer renders.
    for (let i = 0; i < 20; i++) fake.bumpTrace();
    await drain(10);
    expect(renders - baseline).toBe(0);

    // One real status change → exactly one render.
    fake.setStatus('completed');
    await drain(10);
    expect(renders - baseline).toBe(1);
    expect(r.lastFrame()).toBe('completed');
    r.unmount();
  });

  it('useSession: ignores trace-only step notifies, re-renders once on a status change', async () => {
    const fake = createFakeManager('s-2');
    let renders = 0;
    const Probe = (): React.JSX.Element => {
      const rec = useSession('s-2');
      renders += 1;
      return <Text>{rec?.descriptor.status ?? 'none'}</Text>;
    };
    const r = render(
      <SessionsProvider value={fake.mgr}>
        <Probe />
      </SessionsProvider>
    );
    await drain(5);
    const baseline = renders;

    for (let i = 0; i < 20; i++) fake.bumpTrace();
    await drain(10);
    expect(renders - baseline).toBe(0);

    fake.setStatus('failed');
    await drain(10);
    expect(renders - baseline).toBe(1);
    expect(r.lastFrame()).toBe('failed');
    r.unmount();
  });

  it('useSession: re-renders on setPinnedSprint (no status change) but still swallows trace-only', async () => {
    const fake = createFakeManager('s-3');
    let renders = 0;
    const Probe = (): React.JSX.Element => {
      const rec = useSession('s-3');
      renders += 1;
      return <Text>{rec?.descriptor.pinnedSprintId ?? 'unpinned'}</Text>;
    };
    const r = render(
      <SessionsProvider value={fake.mgr}>
        <Probe />
      </SessionsProvider>
    );
    await drain(5);
    const baseline = renders;
    expect(r.lastFrame()).toBe('unpinned');

    // Trace-only notifies stay swallowed (the pinned sprint is unchanged) — no re-render.
    for (let i = 0; i < 20; i++) fake.bumpTrace();
    await drain(10);
    expect(renders - baseline).toBe(0);

    // A mid-run setPinnedSprint changes no status but MUST re-render so the execute view drops
    // the stale (undefined) sprint and shows the now-created one.
    fake.mgr.setPinnedSprint('s-3', 'sprint-42' as SprintId, 'Sprint 42');
    await drain(10);
    expect(renders - baseline).toBe(1);
    expect(r.lastFrame()).toBe('sprint-42');
    r.unmount();
  });
});
