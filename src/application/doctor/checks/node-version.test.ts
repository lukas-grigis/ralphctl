import { describe, expect, it } from 'vitest';

import { nodeVersionCheck } from './node-version.ts';

describe('nodeVersionCheck', () => {
  it('returns pass for the current Node (>= 24)', async () => {
    const r = await nodeVersionCheck();
    expect(r.name).toBe('Node.js version');
    expect(r.status).toBe('pass');
    expect(r.message).toMatch(/^v\d+\.\d+\.\d+/);
  });
});
