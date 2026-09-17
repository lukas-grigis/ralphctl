import { describe, expect, it } from 'vitest';
import { isProcessAlive } from '@src/integration/ai/skills/_engine/skill-install-marker.ts';

describe('isProcessAlive', () => {
  it('reports the current process as alive', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('reports a pid above every platform ceiling as gone', () => {
    expect(isProcessAlive(2_147_483_647)).toBe(false);
  });

  // pid 1 belongs to root (init / launchd): an unprivileged probe gets EPERM, which still means alive.
  it.skipIf(process.platform === 'win32')('treats a process it may not signal as alive', () => {
    expect(isProcessAlive(1)).toBe(true);
  });
});
