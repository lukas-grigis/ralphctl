import type { ChildProcess } from 'node:child_process';

/**
 * Process-group kill for children spawned with `detached: true` (POSIX: leader of a new session
 * and process group). Signalling `-pgid` reaches every process the child started — the tool
 * subprocesses an AI CLI or a shell script forks — not just the leader.
 *
 * Only children registered through {@link markProcessGroupLeader} are group-killed: a test fake
 * carries a made-up pid, and `process.kill(-pid)` against a pid that happens to lead a real group
 * would signal an unrelated process tree. Everything else gets a single-pid `child.kill`.
 */

const groupLeaders = new WeakSet<object>();

/** Whether this platform has POSIX process groups. */
export const supportsProcessGroups = (): boolean => process.platform !== 'win32';

/** Record that `child` was spawned as the leader of its own process group. */
export const markProcessGroupLeader = (child: object): void => {
  groupLeaders.add(child);
};

/** The child's process-group id, when it leads its own group; `undefined` otherwise. */
export const processGroupOf = (child: Pick<ChildProcess, 'pid'>): number | undefined =>
  supportsProcessGroups() && groupLeaders.has(child) && typeof child.pid === 'number' && child.pid > 1
    ? child.pid
    : undefined;

/**
 * Send `sig` to process group `pgid`. Returns false when the group is gone (ESRCH) or the signal
 * was refused. `pgid <= 1` is rejected outright: `kill(-1)` signals every process the user owns.
 */
export const signalProcessGroup = (pgid: number, sig: NodeJS.Signals): boolean => {
  if (!supportsProcessGroups() || !Number.isInteger(pgid) || pgid <= 1) return false;
  try {
    process.kill(-pgid, sig);
    return true;
  } catch {
    return false;
  }
};

/** Kill the child's whole process group when it leads one, else just the child. Never throws. */
export const killProcessTree = (child: Pick<ChildProcess, 'pid' | 'kill'>, sig: NodeJS.Signals): void => {
  const pgid = processGroupOf(child);
  if (pgid !== undefined && signalProcessGroup(pgid, sig)) return;
  try {
    child.kill(sig);
  } catch {
    // already dead.
  }
};
