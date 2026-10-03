/** The footer says [WAITING] only while a RUNNING session is parked on a prompt. */

import { describe, expect, it, vi } from 'vitest';
import { StatusBar } from '@src/application/ui/tui/components/status-bar.tsx';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { Runner } from '@src/application/chain/run/runner.ts';
import { createSessionManager } from '@src/application/ui/tui/runtime/session-manager.ts';
import { createPromptQueue } from '@src/application/ui/tui/prompts/prompt-queue.ts';
import { renderView, waitForViewReady } from '@tests/integration/application/ui/tui/_harness.tsx';

const deps = { eventBus: { publish: vi.fn(), subscribe: () => () => undefined } } as unknown as AppDeps;

const mount = (askedBy: string | undefined): ReturnType<typeof renderView>['result'] => {
  const sessions = createSessionManager();
  sessions.register({
    runner: {
      id: 'r-1',
      status: 'running',
      ctx: {},
      trace: [],
      subscribe: () => () => undefined,
      start: vi.fn(),
      abort: vi.fn(),
    } as unknown as Runner<unknown>,
    flowId: 'refine',
    title: 'Refine — Demo',
  });
  const queue = createPromptQueue();
  if (askedBy !== undefined) {
    queue.enqueue({ kind: 'confirm', message: 'Proceed?', sessionId: askedBy, resolve: vi.fn(), reject: vi.fn() });
  }
  return renderView(<StatusBar />, { deps, initial: { id: 'home' }, sessions, queue }).result;
};

describe('StatusBar WAITING', () => {
  it('flags a run parked on a prompt', async () => {
    const result = mount('r-1');
    await waitForViewReady(result, (f) => f.includes('1 running'));
    expect(result.lastFrame()).toContain('[WAITING]');
    result.unmount();
  });

  it('stays quiet when the prompt belongs to nobody on the list', async () => {
    const result = mount('someone-else');
    await waitForViewReady(result, (f) => f.includes('1 running'));
    expect(result.lastFrame()).not.toContain('[WAITING]');
    result.unmount();
  });
});
