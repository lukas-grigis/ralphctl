import { describe, expect, it } from 'vitest';

import { generateSessionId } from './session-id.ts';

describe('generateSessionId', () => {
  it('returns an 8-char base36 string', () => {
    const id = generateSessionId();
    expect(id).toHaveLength(8);
    expect(id).toMatch(/^[a-z0-9]{8}$/);
  });

  it('produces different ids on subsequent calls', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 32; i++) ids.add(generateSessionId());
    // We expect well over 16 unique values from 32 draws of a ~40-bit
    // space — collision risk is astronomical.
    expect(ids.size).toBeGreaterThan(16);
  });
});
