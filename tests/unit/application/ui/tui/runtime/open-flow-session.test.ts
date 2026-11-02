import { describe, expect, it, vi } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import { createRunner } from '@src/application/chain/run/runner.ts';
import { createSessionManager } from '@src/application/ui/tui/runtime/session-manager.ts';
import { openFlowSession } from '@src/application/ui/tui/runtime/open-flow-session.ts';
import type { RouterApi } from '@src/application/ui/tui/runtime/router.tsx';

const makeRunner = (id: string) =>
  createRunner({
    id,
    element: leaf<object, void, void>('one', {
      useCase: { execute: async () => Result.ok(undefined) },
      input: () => undefined,
      output: (ctx) => ctx,
    }),
    initialCtx: {},
  });

describe('openFlowSession', () => {
  it('registers the runner with its hints (and no launch-result bookkeeping), then routes to Execute', () => {
    const sessions = createSessionManager();
    const router = { push: vi.fn(), replace: vi.fn() } as unknown as RouterApi;
    const runner = makeRunner('r-open');

    openFlowSession(
      { sessions, router },
      { ok: true, runner, title: 'Implement', maxTurns: 4, taskNames: new Map([['t1', 'Task one']]) },
      'implement'
    );

    const descriptor = sessions.get('r-open')?.descriptor;
    expect(descriptor).toMatchObject({ flowId: 'implement', title: 'Implement', maxTurns: 4 });
    expect(descriptor?.taskNames?.get('t1')).toBe('Task one');
    expect(descriptor).not.toHaveProperty('ok');
    expect(router.push).toHaveBeenCalledWith({ id: 'execute', props: { sessionId: 'r-open' } });
  });

  it('replaces the current frame when mode is replace', () => {
    const router = { push: vi.fn(), replace: vi.fn() } as unknown as RouterApi;
    openFlowSession(
      { sessions: createSessionManager(), router },
      { ok: true, runner: makeRunner('r-replace'), title: 'Plan' },
      'plan',
      { mode: 'replace' }
    );
    expect(router.replace).toHaveBeenCalledTimes(1);
    expect(router.push).not.toHaveBeenCalled();
  });
});
