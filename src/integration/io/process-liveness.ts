import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import type {
  MachineRef,
  ProcessGroupTerminator,
  ProcessIdentity,
  ProcessLiveness,
} from '@src/business/runs/live-run.ts';
import { runCommand, type RunCommand } from '@src/integration/io/run-command.ts';
import {
  isProcessGroupAlive,
  signalProcessGroup,
  supportsProcessGroups,
} from '@src/integration/io/kill-process-tree.ts';
import { DEFAULT_KILL_GRACE_MS } from '@src/integration/io/kill-with-escalation.ts';
import { errnoCode } from '@src/integration/io/fs.ts';

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

/** This machine's name, as recorded in lock owner files and live-run records. */
export const currentHost = (): string => hostname();

const LINUX_MACHINE_ID_FILES = ['/etc/machine-id', '/var/lib/dbus/machine-id'];
const MAC_PLATFORM_UUID = /"IOPlatformUUID" = "([^"]+)"/;

/** `undefined` on Windows (its hostname is stable) or when unreadable; callers then compare hostnames. */
export const readMachineId = async (run: RunCommand): Promise<string | undefined> => {
  if (process.platform === 'linux') {
    for (const file of LINUX_MACHINE_ID_FILES) {
      try {
        const id = (await readFile(file, 'utf8')).trim();
        if (id !== '') return id;
      } catch {
        // try the next location
      }
    }
    return undefined;
  }
  if (process.platform !== 'darwin') return undefined;
  const result = await run('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']);
  return result.ok ? MAC_PLATFORM_UUID.exec(result.stdout)?.[1] : undefined;
};

let machineIdOnce: Promise<string | undefined> | undefined;

export const currentMachine = async (run: RunCommand = runCommand): Promise<MachineRef> => {
  machineIdOnce ??= readMachineId(run);
  const machineId = await machineIdOnce;
  return machineId !== undefined ? { host: currentHost(), machineId } : { host: currentHost() };
};

/**
 * `ps` start time + command for `pid`. POSIX only; Windows resolves `undefined`, which every caller
 * treats as "can't tell" and so never kills on it.
 */
const identifyWith =
  (run: RunCommand) =>
  async (pid: number): Promise<ProcessIdentity | undefined> => {
    if (!supportsProcessGroups() || !Number.isInteger(pid) || pid <= 0) return undefined;
    // lstart follows LC_TIME and TZ, so pin both or identities from differently-configured shells never match.
    const result = await run('ps', ['-o', 'lstart=', '-o', 'comm=', '-p', String(pid)], {
      env: { LC_ALL: 'C', TZ: 'UTC' },
    });
    if (!result.ok) return undefined;
    const line = result.stdout.trim();
    // lstart is a fixed five-field date ("Thu Oct  1 21:11:32 2026"); comm is the rest.
    const match = /^(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s+(.+)$/.exec(line);
    if (match === null) return undefined;
    return { startedAt: match[1]!.replace(/\s+/g, ' '), command: match[2]!.trim() };
  };

let selfIdentityOnce: Promise<ProcessIdentity | undefined> | undefined;

/** This process's `ps` identity, probed once; stamped into lock owner files. */
export const currentProcessIdentity = (run: RunCommand = runCommand): Promise<ProcessIdentity | undefined> =>
  (selfIdentityOnce ??= identifyWith(run)(process.pid));

export interface ProcessLivenessDeps {
  /** Test seam for the `ps` call. */
  readonly runCommand?: RunCommand;
}

export const createProcessLiveness = (deps: ProcessLivenessDeps = {}): ProcessLiveness => ({
  get host() {
    return currentHost();
  },
  selfPid: process.pid,
  machine: () => currentMachine(deps.runCommand ?? runCommand),
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
