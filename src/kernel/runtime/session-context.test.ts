import { describe, expect, it } from 'vitest';

import { currentSessionId, runWithSession } from './session-context.ts';

describe('session-context (AsyncLocalStorage)', () => {
  it('returns undefined outside any scope', () => {
    expect(currentSessionId()).toBeUndefined();
  });

  it('exposes the active id inside runWithSession', async () => {
    const seen = await runWithSession('sess-A', () => Promise.resolve(currentSessionId()));
    expect(seen).toBe('sess-A');
  });

  it('propagates the id across awaits', async () => {
    const seen: (string | undefined)[] = [];
    await runWithSession('sess-B', async () => {
      seen.push(currentSessionId());
      await Promise.resolve();
      seen.push(currentSessionId());
      await new Promise((r) => setTimeout(r, 1));
      seen.push(currentSessionId());
    });
    expect(seen).toStrictEqual(['sess-B', 'sess-B', 'sess-B']);
  });

  it('keeps two concurrent scopes isolated', async () => {
    const a = runWithSession('A', async () => {
      await Promise.resolve();
      return currentSessionId();
    });
    const b = runWithSession('B', async () => {
      await Promise.resolve();
      return currentSessionId();
    });
    const [seenA, seenB] = await Promise.all([a, b]);
    expect(seenA).toBe('A');
    expect(seenB).toBe('B');
  });

  it('restores the previous (undefined) scope after the call settles', async () => {
    expect(currentSessionId()).toBeUndefined();
    await runWithSession('inner', () => Promise.resolve());
    expect(currentSessionId()).toBeUndefined();
  });
});
