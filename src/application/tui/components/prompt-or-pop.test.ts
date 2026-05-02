import { describe, expect, it, vi } from 'vitest';

import { PromptCancelledError } from '@src/business/ports/prompt-port.ts';
import { promptOrPop } from './prompt-or-pop.ts';

describe('promptOrPop', () => {
  it("returns the call's resolved value on success", async () => {
    const router = { pop: vi.fn() };
    const result = await promptOrPop(router, () => Promise.resolve('ok'));
    expect(result).toBe('ok');
    expect(router.pop).not.toHaveBeenCalled();
  });

  it('pops the router and rethrows on PromptCancelledError', async () => {
    const router = { pop: vi.fn() };
    const cancel = new PromptCancelledError();
    await expect(promptOrPop(router, () => Promise.reject(cancel))).rejects.toBe(cancel);
    expect(router.pop).toHaveBeenCalledTimes(1);
  });

  it('rethrows other errors without popping', async () => {
    const router = { pop: vi.fn() };
    const boom = new Error('boom');
    await expect(promptOrPop(router, () => Promise.reject(boom))).rejects.toBe(boom);
    expect(router.pop).not.toHaveBeenCalled();
  });
});
