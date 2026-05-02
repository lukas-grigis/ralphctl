import { describe, expect, it } from 'vitest';

import { gitIdentityCheck } from './git-identity.ts';

describe('gitIdentityCheck', () => {
  it('returns pass or warn (never fail) — missing identity is non-blocking', async () => {
    const r = await gitIdentityCheck();
    expect(r.name).toBe('Git identity');
    expect(['pass', 'warn']).toContain(r.status);
    if (r.status === 'pass') {
      expect(r.message).toContain('<');
      expect(r.message).toContain('>');
    } else {
      expect(r.message).toMatch(/missing/);
    }
  });
});
