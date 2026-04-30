import { describe, expect, it } from 'vitest';

import { defaultSessionIdGenerator } from './session-id-generator.ts';

describe('defaultSessionIdGenerator', () => {
  it('returns an 8-char lowercase hex string', () => {
    const id = defaultSessionIdGenerator();
    expect(id).toHaveLength(8);
    expect(id).toMatch(/^[a-f0-9]{8}$/);
  });

  it('produces different ids on subsequent calls', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 64; i++) ids.add(defaultSessionIdGenerator());
    // 32 random bits → collision risk in 64 draws is astronomically small.
    // We expect every draw to be unique.
    expect(ids.size).toBe(64);
  });
});
