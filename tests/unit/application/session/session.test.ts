import { describe, expect, it } from 'vitest';
import { currentSessionId, runWithSession } from '@src/application/session/session.ts';

describe('session-context', () => {
  it('returns undefined outside any scope', () => {
    expect(currentSessionId()).toBeUndefined();
  });

  it('reads the id inside the scope', async () => {
    const result = await runWithSession('sid-1', async () => currentSessionId());
    expect(result).toBe('sid-1');
  });

  it('threads the id through awaited async work', async () => {
    const inner = async (): Promise<string | undefined> => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 1));
      return currentSessionId();
    };
    const result = await runWithSession('sid-2', inner);
    expect(result).toBe('sid-2');
  });

  it('nested scopes shadow the outer id', async () => {
    let outerSeen: string | undefined;
    let innerSeen: string | undefined;
    await runWithSession('outer', async () => {
      outerSeen = currentSessionId();
      await runWithSession('inner', async () => {
        innerSeen = currentSessionId();
      });
      // Outer scope still active here.
      expect(currentSessionId()).toBe('outer');
    });
    expect(outerSeen).toBe('outer');
    expect(innerSeen).toBe('inner');
  });
});
