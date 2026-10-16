import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { killWithEscalation } from '@src/integration/io/kill-with-escalation.ts';
import { markProcessGroupLeader } from '@src/integration/io/kill-process-tree.ts';

interface FakeChild extends EventEmitter {
  kill: (signal?: NodeJS.Signals) => boolean;
  readonly signals: NodeJS.Signals[];
}

const makeChild = (over: Partial<Pick<FakeChild, 'kill'>> = {}): FakeChild => {
  const child = new EventEmitter() as FakeChild;
  const signals: NodeJS.Signals[] = [];
  Object.assign(child, {
    signals,
    kill:
      over.kill ??
      ((signal?: NodeJS.Signals): boolean => {
        signals.push(signal ?? 'SIGTERM');
        return true;
      }),
  });
  return child;
};

describe('killWithEscalation', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('sends SIGTERM immediately, then SIGKILL after the grace when the child ignores SIGTERM', () => {
    vi.useFakeTimers();
    const child = makeChild();
    killWithEscalation(child as unknown as ChildProcess, 50);

    expect(child.signals).toEqual(['SIGTERM']);
    vi.advanceTimersByTime(50);
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('does NOT escalate to SIGKILL when the child exits within the grace window', () => {
    vi.useFakeTimers();
    const child = makeChild();
    killWithEscalation(child as unknown as ChildProcess, 50);
    expect(child.signals).toEqual(['SIGTERM']);

    // Child honours SIGTERM and exits before the grace elapses — the escalation must be cancelled.
    child.emit('exit', null, 'SIGTERM');
    vi.advanceTimersByTime(100);
    expect(child.signals).toEqual(['SIGTERM']);
  });

  it('swallows an already-dead (ESRCH) kill throw on both the SIGTERM and the SIGKILL step', () => {
    vi.useFakeTimers();
    const child = makeChild({
      kill: (): boolean => {
        throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
      },
    });

    expect(() => killWithEscalation(child as unknown as ChildProcess, 50)).not.toThrow();
    expect(() => vi.advanceTimersByTime(50)).not.toThrow();
  });

  it.skipIf(process.platform === 'win32')(
    "signals a group leader's whole group and still SIGKILLs it after the leader exits",
    () => {
      vi.useFakeTimers();
      const groupKills: Array<[number, string | number | undefined]> = [];
      vi.spyOn(process, 'kill').mockImplementation((pid, sig) => {
        groupKills.push([pid, sig]);
        return true;
      });
      const child = makeChild();
      Object.assign(child, { pid: 4242 });
      markProcessGroupLeader(child);

      killWithEscalation(child as unknown as ChildProcess, 50);
      // A hook the leader forked can outlive it; the group SIGKILL must still land.
      child.emit('exit', null, 'SIGTERM');
      vi.advanceTimersByTime(50);

      expect(groupKills).toEqual([
        [-4242, 'SIGTERM'],
        [-4242, 'SIGKILL'],
      ]);
      expect(child.signals).toEqual([]);
    }
  );
});
