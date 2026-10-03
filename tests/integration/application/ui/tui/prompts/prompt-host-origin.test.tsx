/** A prompt raised by another run names that run; on the run's own Execute view the title is unchanged. */

import { vi } from 'vitest';
import { describe, expect, it } from 'vitest';
import { PromptHost } from '@src/application/ui/tui/prompts/prompt-host.tsx';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { Runner } from '@src/application/chain/run/runner.ts';
import { createSessionManager } from '@src/application/ui/tui/runtime/session-manager.ts';
import { createPromptQueue } from '@src/application/ui/tui/prompts/prompt-queue.ts';
import type { ViewEntry } from '@src/application/ui/tui/runtime/router.tsx';
import { renderView, waitForViewReady } from '@tests/integration/application/ui/tui/_harness.tsx';

const runner = {
  id: 'r-impl',
  status: 'running',
  trace: [],
  subscribe: () => () => undefined,
} as unknown as Runner<unknown>;

const renderHost = async (initial: ViewEntry): Promise<string> => {
  const sessions = createSessionManager();
  sessions.register({ runner, flowId: 'implement', title: 'Implement — Demo', pinnedSprintLabel: 'Hello Python' });
  const queue = createPromptQueue();
  queue.enqueue({ kind: 'confirm', message: 'Proceed?', sessionId: 'r-impl', resolve: vi.fn(), reject: vi.fn() });
  const { result } = renderView(<PromptHost queue={queue} />, {
    deps: {} as unknown as AppDeps,
    initial,
    sessions,
    queue,
  });
  await waitForViewReady(result, (f) => f.includes('Question'));
  const frame = result.lastFrame() ?? '';
  result.unmount();
  return frame;
};

describe('PromptHost origin', () => {
  it('names the flow and sprint when the asking run is not on screen', async () => {
    const frame = await renderHost({ id: 'home' });
    expect(frame).toContain('Question');
    expect(frame).toContain('from Implement · Hello Python');
  });

  it("leaves the title alone on the asking run's own Execute view", async () => {
    const frame = await renderHost({ id: 'execute', props: { sessionId: 'r-impl' } });
    expect(frame).toContain('Question');
    expect(frame).not.toContain('from ');
  });
});
