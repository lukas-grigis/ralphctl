/** Two answering keys delivered before a re-render answer only the prompt on screen, never the one queued behind it. */

import { describe, expect, it, vi } from 'vitest';
import { PromptHost } from '@src/application/ui/tui/prompts/prompt-host.tsx';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import { createPromptQueue } from '@src/application/ui/tui/prompts/prompt-queue.ts';
import { renderView, waitForViewReady } from '@tests/integration/application/ui/tui/_harness.tsx';
import { tick } from '@tests/integration/application/ui/tui/_keys.ts';

describe('PromptHost stale answers', () => {
  it('a second answering key before re-render leaves the next prompt pending', async () => {
    const queue = createPromptQueue();
    const first = { resolve: vi.fn(), reject: vi.fn() };
    const second = { resolve: vi.fn(), reject: vi.fn() };
    queue.enqueue({ kind: 'confirm', message: 'First?', ...first });
    queue.enqueue({ kind: 'confirm', message: 'Second?', ...second });
    const { result } = renderView(<PromptHost queue={queue} />, {
      deps: {} as unknown as AppDeps,
      initial: { id: 'home' },
      queue,
    });
    await waitForViewReady(result, (f) => f.includes('First?'));

    result.stdin.write('n');
    result.stdin.write('n');
    await tick();

    expect(first.resolve).toHaveBeenCalledWith(false);
    expect(second.resolve).not.toHaveBeenCalled();
    expect(second.reject).not.toHaveBeenCalled();
    expect(queue.size).toBe(1);
    result.unmount();
  });
});
