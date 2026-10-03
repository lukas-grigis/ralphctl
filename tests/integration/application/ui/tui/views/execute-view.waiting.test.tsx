/** A run blocked on a prompt reads WAITING on every surface that shows the run, with no spinner. */

import { vi } from 'vitest';
import { describe, expect, it } from 'vitest';
import { ExecuteView } from '@src/application/ui/tui/views/execute-view.tsx';
import { SessionsView } from '@src/application/ui/tui/views/sessions-view.tsx';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { Runner } from '@src/application/chain/run/runner.ts';
import { createSessionManager } from '@src/application/ui/tui/runtime/session-manager.ts';
import { createPromptQueue, type PromptQueue } from '@src/application/ui/tui/prompts/prompt-queue.ts';
import { glyphs } from '@src/application/ui/tui/theme/tokens.ts';
import { renderView, waitForViewReady } from '@tests/integration/application/ui/tui/_harness.tsx';

const deps = { eventBus: { publish: vi.fn(), subscribe: () => () => undefined } } as unknown as AppDeps;

const fakeRunner = (id: string): Runner<unknown> =>
  ({
    id,
    status: 'running',
    ctx: {},
    trace: [],
    subscribe: () => () => undefined,
    start: vi.fn(),
    abort: vi.fn(),
  }) as never;

const ask = (queue: PromptQueue, sessionId: string): void => {
  queue.enqueue({
    kind: 'confirm',
    message: 'Proceed?',
    sessionId,
    resolve: () => undefined,
    reject: () => undefined,
  });
};

const hasSpinnerFrame = (frame: string): boolean => glyphs.spinner.some((f) => frame.includes(f));

describe('WAITING state', () => {
  it('Execute header and chip say WAITING and drop the spinner while a prompt blocks the run', async () => {
    const sessions = createSessionManager();
    sessions.register({ runner: fakeRunner('r-w'), flowId: 'implement', title: 'Implement — Demo' });
    const queue = createPromptQueue();
    ask(queue, 'r-w');

    const { result } = renderView(<ExecuteView />, {
      deps,
      initial: { id: 'execute', props: { sessionId: 'r-w' } },
      sessions,
      queue,
    });
    await waitForViewReady(result, (f) => f.includes('Implement — Demo'));
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('[WAITING]');
    expect(frame).toContain('waiting');
    expect(frame).not.toContain('[RUNNING]');
    expect(frame).not.toContain('live');
    // The footer's doctor probe spins independently; only the run's own header row is under test.
    const headerRow = frame.split('\n').find((l) => l.includes('flow implement')) ?? '';
    expect(hasSpinnerFrame(headerRow)).toBe(false);
    result.unmount();
  });

  it('Execute keeps the live spinner and [RUNNING] when only another run is waiting', async () => {
    const sessions = createSessionManager();
    sessions.register({ runner: fakeRunner('r-a'), flowId: 'implement', title: 'Implement — Demo' });
    const queue = createPromptQueue();
    ask(queue, 'someone-else');

    const { result } = renderView(<ExecuteView />, {
      deps,
      initial: { id: 'execute', props: { sessionId: 'r-a' } },
      sessions,
      queue,
    });
    await waitForViewReady(result, (f) => f.includes('Implement — Demo'));
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('[RUNNING]');
    expect(frame).not.toContain('[WAITING]');
    result.unmount();
  });

  it('the Sessions list row shows WAITING for the awaiting session only', async () => {
    const sessions = createSessionManager();
    sessions.register({ runner: fakeRunner('r-1'), flowId: 'implement', title: 'Alpha run' });
    sessions.register({ runner: fakeRunner('r-2'), flowId: 'refine', title: 'Beta run' });
    const queue = createPromptQueue();
    ask(queue, 'r-2');

    const { result } = renderView(<SessionsView />, { deps, initial: { id: 'sessions' }, sessions, queue });
    await waitForViewReady(result, (f) => f.includes('Beta run'));
    const lines = (result.lastFrame() ?? '').split('\n');
    expect(lines.find((l) => l.includes('Beta run'))).toContain('[WAITING]');
    expect(lines.find((l) => l.includes('Alpha run'))).toContain('[RUNNING]');
    result.unmount();
  });
});
