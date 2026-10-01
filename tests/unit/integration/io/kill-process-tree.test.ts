import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  killProcessTree,
  markProcessGroupLeader,
  processGroupOf,
  signalProcessGroup,
} from '@src/integration/io/kill-process-tree.ts';

const posix = process.platform !== 'win32';

const fakeChild = (pid: number | undefined) => {
  const kills: string[] = [];
  return { pid, kills, kill: (sig?: NodeJS.Signals | number) => (kills.push(String(sig)), true) };
};

describe('killProcessTree', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('never group-kills a child it was not told leads a group — a fake pid must not hit a real group', () => {
    const groupKill = vi.spyOn(process, 'kill');
    const child = fakeChild(4242);

    killProcessTree(child, 'SIGTERM');

    expect(groupKill).not.toHaveBeenCalled();
    expect(child.kills).toEqual(['SIGTERM']);
    expect(processGroupOf(child)).toBeUndefined();
  });

  it.skipIf(!posix)('signals the group of a marked leader', () => {
    const groupKill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const child = fakeChild(4242);
    markProcessGroupLeader(child);

    killProcessTree(child, 'SIGKILL');

    expect(groupKill).toHaveBeenCalledWith(-4242, 'SIGKILL');
    expect(child.kills).toEqual([]);
  });

  it.skipIf(!posix)('falls back to the child when its group is already gone', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    });
    const child = fakeChild(4243);
    markProcessGroupLeader(child);

    killProcessTree(child, 'SIGTERM');

    expect(child.kills).toEqual(['SIGTERM']);
  });

  it('refuses pgid 0 and 1 — kill(-1) would signal every process the user owns', () => {
    const groupKill = vi.spyOn(process, 'kill');

    expect(signalProcessGroup(1, 'SIGTERM')).toBe(false);
    expect(signalProcessGroup(0, 'SIGTERM')).toBe(false);
    expect(groupKill).not.toHaveBeenCalled();
    const leader = fakeChild(1);
    markProcessGroupLeader(leader);
    expect(processGroupOf(leader)).toBeUndefined();
  });
});
