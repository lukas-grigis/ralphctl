/**
 * `y` (copy the active task's summary) is Execute-local: it is hinted and handled on the Execute
 * view while a task is active, and does nothing anywhere else — no global handler, no
 * "no active task" toast.
 */

import { describe, expect, it, vi } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { ExecuteView } from '@src/application/ui/tui/views/execute-view.tsx';
import { useGlobalKeys } from '@src/application/ui/tui/runtime/use-global-keys.ts';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { createSessionManager } from '@src/application/ui/tui/runtime/session-manager.ts';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { Runner } from '@src/application/chain/run/runner.ts';
import type { Trace, TraceEntry } from '@src/application/chain/trace.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { tick } from '@tests/integration/application/ui/tui/_keys.ts';
import { waitForPredicate } from '@tests/integration/application/ui/tui/_wait.ts';
import { renderView, waitForViewReady } from '@tests/integration/application/ui/tui/_harness.tsx';

const copied: string[] = [];
vi.mock('@src/integration/io/clipboard.ts', () => ({
  createCopyToClipboard: () => async (text: string) => {
    copied.push(text);
    return Result.ok(undefined);
  },
}));

const makeBus = (): { bus: EventBus; published: Array<{ type: string; message?: string }> } => {
  const published: Array<{ type: string; message?: string }> = [];
  const bus = {
    publish: (e: { type: string; message?: string }) => published.push(e),
    subscribe: () => () => undefined,
  } as unknown as EventBus;
  return { bus, published };
};

const GlobalKeys = (): null => {
  const ui = useUiState();
  useGlobalKeys({ disabled: ui.promptActive });
  return null;
};

describe('y — copy active task', () => {
  it('does nothing outside Execute (no banner published)', async () => {
    const { bus, published } = makeBus();
    const { result } = renderView(<GlobalKeys />, {
      deps: { eventBus: bus } as unknown as AppDeps,
      initial: { id: 'home' },
    });
    await tick();
    result.stdin.write('y');
    await tick(60);
    expect(published.filter((e) => e.type === 'banner-show')).toEqual([]);
    expect(copied).toEqual([]);
    result.unmount();
  });

  it('on Execute with an active task: hints `y copy task` and publishes "Copied to clipboard"', async () => {
    const T1 = '01933fbb-1111-7000-8000-000000000001';
    const trace: TraceEntry[] = [{ elementName: `generator-${T1}`, status: 'completed', durationMs: 100 }];
    const runner = {
      id: 'r-copy',
      status: 'running' as const,
      ctx: {},
      trace: trace as Trace,
      subscribe: () => () => undefined,
      start: vi.fn(),
      abort: vi.fn(),
    } as unknown as Runner<unknown>;
    const sessions = createSessionManager();
    sessions.register({
      runner,
      flowId: 'implement',
      title: 'Implement — Copy',
      pinnedSprintId: 'sprint-copy' as unknown as SprintId,
      taskNames: new Map([[T1, 'Only task']]),
      terminalSubstepName: 'uninstall-skills',
      maxTurns: 10,
    });
    const { bus, published } = makeBus();
    const deps = {
      eventBus: bus,
      sprintExecutionRepo: { findById: vi.fn().mockResolvedValue({ ok: false }) },
      taskRepo: {
        findById: vi.fn().mockResolvedValue({ ok: false }),
        findBySprintId: vi.fn().mockResolvedValue({ ok: true, value: [] }),
      },
    } as unknown as AppDeps;

    const { result } = renderView(<ExecuteView />, {
      deps,
      initial: { id: 'execute', props: { sessionId: 'r-copy' } },
      sessions,
    });
    await waitForViewReady(result, (f) => f.includes('Implement — Copy'));
    expect(result.lastFrame() ?? '').toContain('y copy task');

    result.stdin.write('y');
    await waitForPredicate(() => published.some((e) => e.type === 'banner-show'));
    expect(published.find((e) => e.type === 'banner-show')?.message).toBe('Copied to clipboard');
    expect(copied).toHaveLength(1);
    result.unmount();
  });
});
