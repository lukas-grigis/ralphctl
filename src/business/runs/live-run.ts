import type { Result } from '@src/domain/result.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';

/**
 * Live-run record: one file per in-flight flow run at `<stateRoot>/runs/<runId>.json`, written when
 * the run starts, updated per AI CLI spawn, deleted when the run settles. A record that outlives its
 * owning process is the evidence that the run was interrupted (crash, SIGKILL, power loss) and
 * names the process groups it may have orphaned.
 */

export const LIVE_RUN_RECORD_VERSION = 1;

/** What `ps` reports for a pid; compared verbatim to tell a recycled pid from the original process. */
export interface ProcessIdentity {
  readonly startedAt: string;
  readonly command: string;
}

/** `host` alone is unstable (macOS renames on DHCP / mDNS), so a machine id decides when both sides have one. */
export interface MachineRef {
  readonly host: string;
  readonly machineId?: string;
}

export const sameMachine = (a: MachineRef, b: MachineRef): boolean =>
  a.machineId !== undefined && b.machineId !== undefined ? a.machineId === b.machineId : a.host === b.host;

/** The harness process that owns a run. */
export interface LiveRunOwner extends MachineRef {
  readonly pid: number;
  readonly startedAt: string;
  readonly identity?: ProcessIdentity;
}

/** One headless AI CLI spawn inside a run. */
export interface LiveRunSpawn {
  readonly pid: number;
  /** Process group the child leads (POSIX); absent on Windows. */
  readonly pgid?: number;
  readonly provider: string;
  readonly command: string;
  readonly cwd: string;
  readonly role?: 'generator' | 'evaluator';
  /** Gen-eval round, when the spawn's sandbox path names one. */
  readonly round?: number;
  readonly signalsFile: string;
  readonly sessionId?: string;
  readonly identity?: ProcessIdentity;
  readonly startedAt: string;
  /** Set once the child exited; a spawn without it was still running when the record was last written. */
  readonly exitedAt?: string;
}

export interface LiveRunRecord {
  readonly version: number;
  readonly runId: string;
  readonly flowId: string;
  readonly projectId?: string;
  readonly sprintId?: string;
  readonly owner: LiveRunOwner;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly spawns: readonly LiveRunSpawn[];
  /** Stamped once the boot-time reap handled this record, so it is not reaped twice. */
  readonly reapedAt?: string;
}

/** Persistence for live-run records. Readers tolerate unparseable files by skipping them. */
export interface LiveRunStore {
  list(): Promise<Result<readonly LiveRunRecord[], StorageError>>;
  save(record: LiveRunRecord): Promise<Result<void, StorageError>>;
  remove(runId: string): Promise<Result<void, StorageError>>;
}

/** Process facts about this host. `identify` resolves `undefined` when the pid is gone or the platform can't say. */
export interface ProcessLiveness {
  readonly host: string;
  readonly selfPid: number;
  machine(): Promise<MachineRef>;
  isAlive(pid: number): boolean;
  isGroupAlive(pgid: number): boolean;
  identify(pid: number): Promise<ProcessIdentity | undefined>;
}

/** SIGTERM a process group now and SIGKILL it after a grace window. */
export interface ProcessGroupTerminator {
  terminateGroup(pgid: number): void;
}

/** The spawns of `record` that had not exited when it was last written. */
export const liveSpawnsOf = (record: LiveRunRecord): readonly LiveRunSpawn[] =>
  record.spawns.filter((spawn) => spawn.exitedAt === undefined);

export const sameIdentity = (a: ProcessIdentity | undefined, b: ProcessIdentity | undefined): boolean =>
  a !== undefined && b !== undefined && a.startedAt === b.startedAt && a.command === b.command;
