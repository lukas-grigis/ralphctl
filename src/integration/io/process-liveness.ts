import { hostname } from 'node:os';
import type { ProcessGroupTerminator, ProcessIdentity, ProcessLiveness } from '@src/business/runs/live-run.ts';
import { runCommand, type RunCommand } from '@src/integration/io/run-command.ts';
import { signalProcessGroup, supportsProcessGroups } from '@src/integration/io/kill-process-tree.ts';
import { DEFAULT_KILL_GRACE_MS } from '@src/integration/io/kill-with-escalation.ts';

const errnoCode = (cause: unknown): string | undefined =>
  typeof cause === 'object' && cause !== null && typeof (cause as { code?: unknown }).code === 'string'
    ? (cause as { code: string }).code
    : undefined;

/**
 * Signal-0 liveness probe. `ESRCH` means the process is gone. `EPERM` means it exists but belongs
 * to another user, and any other failure proves nothing, so both count as alive.
 */
export const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return errnoCode(cause) !== 'ESRCH';
  }
};

/** Whether any process is still in group `pgid`. Same EPERM rule as {@link isProcessAlive}. */
const isProcessGroupAlive = (pgid: number): boolean => {
  if (!supportsProcessGroups() || !Number.isInteger(pgid) || pgid <= 1) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (cause) {
    return errnoCode(cause) !== 'ESRCH';
  }
};

/** This machine's name, as recorded in lock owner files and live-run records. */
export const currentHost = (): string => hostname();

/**
 * `ps` start time + command for `pid`. POSIX only; Windows resolves `undefined`, which every caller
 * treats as "can't tell" and so never kills on it.
 */
const identifyWith =
  (run: RunCommand) =>
  async (pid: number): Promise<ProcessIdentity | undefined> => {
    if (!supportsProcessGroups() || !Number.isInteger(pid) || pid <= 0) return undefined;
    const result = await run('ps', ['-o', 'lstart=', '-o', 'comm=', '-p', String(pid)]);
    if (!result.ok) return undefined;
    const line = result.stdout.trim();
    // lstart is a fixed five-field date ("Thu Oct  1 21:11:32 2026"); comm is the rest.
    const match = /^(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s+(.+)$/.exec(line);
    if (match === null) return undefined;
    return { startedAt: match[1]!.replace(/\s+/g, ' '), command: match[2]!.trim() };
  };

export interface ProcessLivenessDeps {
  /** Test seam for the `ps` call. */
  readonly runCommand?: RunCommand;
}

export const createProcessLiveness = (deps: ProcessLivenessDeps = {}): ProcessLiveness => ({
  get host() {
    return currentHost();
  },
  isAlive: isProcessAlive,
  isGroupAlive: isProcessGroupAlive,
  identify: identifyWith(deps.runCommand ?? runCommand),
});

/** SIGTERM the group now, SIGKILL it after `graceMs` unless it is already gone. */
export const createProcessGroupTerminator = (graceMs: number = DEFAULT_KILL_GRACE_MS): ProcessGroupTerminator => ({
  terminateGroup(pgid) {
    if (!signalProcessGroup(pgid, 'SIGTERM')) return;
    const escalation = setTimeout(() => {
      if (isProcessGroupAlive(pgid)) signalProcessGroup(pgid, 'SIGKILL');
    }, graceMs);
    escalation.unref();
  },
});
