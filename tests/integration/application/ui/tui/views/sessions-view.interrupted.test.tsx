/** Runs an earlier process left behind sit in the list as `interrupted`; `d` drops the record, ↵ points at Home. */

import { describe, expect, it, vi } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { SessionsView } from '@src/application/ui/tui/views/sessions-view.tsx';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { InterruptedRun } from '@src/business/runs/detect-interrupted-runs.ts';
import { renderView, waitForViewReady } from '@tests/integration/application/ui/tui/_harness.tsx';
import { waitForPredicate } from '@tests/integration/application/ui/tui/_wait.ts';

const run = (runId: string): InterruptedRun => ({
  liveSpawns: [],
  record: {
    version: 1,
    runId,
    flowId: 'implement',
    owner: { host: 'h', pid: 1, startedAt: '2026-01-01T00:00:00.000Z' },
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:12:00.000Z',
    spawns: [],
  },
});

const mount = (): {
  readonly result: ReturnType<typeof renderView>['result'];
  readonly dismiss: ReturnType<typeof vi.fn>;
  readonly routeIds: () => readonly string[];
} => {
  let left = [run('dead-1')];
  const dismiss = vi.fn((ids: readonly string[]) => {
    left = left.filter((r) => !ids.includes(r.record.runId));
    return Promise.resolve(Result.ok(undefined));
  });
  const deps = {
    detectInterruptedRuns: { execute: () => Promise.resolve(Result.ok(left)) },
    dismissInterruptedRuns: { execute: dismiss },
  } as unknown as AppDeps;
  const { result, routeIds } = renderView(<SessionsView />, { deps, initial: { id: 'sessions' } });
  return { result, dismiss, routeIds };
};

describe('SessionsView — interrupted runs', () => {
  it('lists the dead run with an interrupted chip and the dismiss hint', async () => {
    const { result } = mount();
    await waitForViewReady(result, (f) => f.includes('interrupted'));
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('Implement — interrupted');
    expect(frame).toContain('[INTERRUPTED]');
    expect(frame).toContain('d dismiss');
    expect(frame).toContain('resume on Home');
    result.unmount();
  });

  it('d dismisses the record and the row goes away', async () => {
    const { result, dismiss } = mount();
    await waitForViewReady(result, (f) => f.includes('interrupted'));
    result.stdin.write('d');
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('dismissed the interrupted Implement run'));
    expect(dismiss).toHaveBeenCalledWith(['dead-1']);
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('No sessions yet'));
    result.unmount();
  });

  it('↵ sends the operator Home, where the resume is offered', async () => {
    const { result, routeIds } = mount();
    await waitForViewReady(result, (f) => f.includes('interrupted'));
    result.stdin.write('\r');
    await waitForPredicate(() => routeIds().at(-1) === 'home');
    result.unmount();
  });
});
