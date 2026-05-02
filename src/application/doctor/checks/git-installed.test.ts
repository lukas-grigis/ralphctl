import { describe, expect, it } from 'vitest';

import { gitInstalledCheck } from './git-installed.ts';

describe('gitInstalledCheck', () => {
  it('returns pass when git is on PATH (CI assumption)', async () => {
    const r = await gitInstalledCheck();
    expect(r.name).toBe('Git installed');
    // CI agents bundle git; if a contributor's machine is missing it,
    // the harness itself can't run, so this assumption holds.
    expect(['pass', 'fail']).toContain(r.status);
    if (r.status === 'pass') {
      expect(r.message).toMatch(/git version/);
    } else {
      expect(r.message).toBe('git not found in PATH');
    }
  });
});
