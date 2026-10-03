import type { Logger } from '@src/business/observability/logger.ts';
import {
  LIVE_RUN_RECORD_VERSION,
  type LiveRunOwner,
  type LiveRunRecord,
  type LiveRunSpawn,
  type LiveRunStore,
  type MachineRef,
  type ProcessIdentity,
  type ProcessLiveness,
} from '@src/business/runs/live-run.ts';
import type { RegisteredChild } from '@src/integration/ai/providers/_engine/child-registry.ts';

/** What the launcher knows about a run when it is handed over for tracking. */
export interface LiveRunMeta {
  readonly flowId: string;
  readonly projectId?: string;
  readonly sprintId?: string;
}

export interface RecordedSpawn {
  noteSessionId(sessionId: string): void;
  exited(): void;
}

/**
 * Keeps `<stateRoot>/runs/<runId>.json` in step with one process's live runs: written at `begin`,
 * rewritten on every spawn change, removed at `end`. Writes for one run are serialised so an older
 * snapshot's rename can never land after a newer one, and nothing is written after `end`.
 */
export interface LiveRunRecorder {
  begin(runId: string, meta: LiveRunMeta): void;
  /** Undefined when `runId` is not a run this recorder tracks (a one-shot CLI spawn, a settled run). */
  spawnStarted(runId: string, child: RegisteredChild): RecordedSpawn | undefined;
  end(runId: string): void;
  /** Resolves once every queued record write and removal has landed. */
  idle(): Promise<void>;
}

export interface LiveRunRecorderDeps {
  readonly store: LiveRunStore;
  readonly liveness: ProcessLiveness;
  readonly now: () => string;
  readonly logger: Logger;
}

/** Exited spawns kept per record — enough for crash recovery to find the last round's session. */
const EXITED_SPAWNS_KEPT = 8;

const roundOf = (signalsFile: string): number | undefined => {
  const match = /[/\\]rounds[/\\](\d+)[/\\]/.exec(signalsFile);
  return match === null ? undefined : Number(match[1]);
};

const trimHistory = (spawns: readonly LiveRunSpawn[]): readonly LiveRunSpawn[] => {
  const exited = spawns.filter((s) => s.exitedAt !== undefined);
  if (exited.length <= EXITED_SPAWNS_KEPT) return spawns;
  const dropped = new Set(exited.slice(0, exited.length - EXITED_SPAWNS_KEPT));
  return spawns.filter((s) => !dropped.has(s));
};

const newRecord = (runId: string, meta: LiveRunMeta, owner: LiveRunOwner, now: string): LiveRunRecord => ({
  version: LIVE_RUN_RECORD_VERSION,
  runId,
  flowId: meta.flowId,
  ...(meta.projectId !== undefined ? { projectId: meta.projectId } : {}),
  ...(meta.sprintId !== undefined ? { sprintId: meta.sprintId } : {}),
  owner,
  startedAt: now,
  updatedAt: now,
  spawns: [],
});

const newSpawn = (child: RegisteredChild, now: string): LiveRunSpawn => {
  const round = roundOf(child.signalsFile);
  return {
    pid: child.pid,
    ...(child.pgid !== undefined ? { pgid: child.pgid } : {}),
    provider: child.provider,
    command: child.command,
    cwd: child.cwd,
    ...(child.role !== undefined ? { role: child.role } : {}),
    ...(round !== undefined ? { round } : {}),
    signalsFile: child.signalsFile,
    startedAt: now,
  };
};

interface RunState {
  record: LiveRunRecord;
  writes: Promise<void>;
}

const pendingWork = (): { track(work: Promise<void>): void; idle(): Promise<void> } => {
  const pending = new Set<Promise<void>>();
  return {
    track(work) {
      const settled = work.catch(() => {});
      pending.add(settled);
      void settled.then(() => pending.delete(settled));
    },
    async idle() {
      while (pending.size > 0) await Promise.all([...pending]);
    },
  };
};

const lateOwnerFacts = (
  identity: ProcessIdentity | undefined,
  machine: MachineRef
): Partial<LiveRunOwner> | undefined => {
  if (identity === undefined && machine.machineId === undefined) return undefined;
  return {
    ...(identity !== undefined ? { identity } : {}),
    ...(machine.machineId !== undefined ? { machineId: machine.machineId } : {}),
  };
};

export const createLiveRunRecorder = (deps: LiveRunRecorderDeps): LiveRunRecorder => {
  const runs = new Map<string, RunState>();
  const { track, idle } = pendingWork();
  const processStartedAt = new Date(Date.now() - process.uptime() * 1000).toISOString();
  let ownerIdentity: Promise<ProcessIdentity | undefined> | undefined;
  let ownerMachine: Promise<MachineRef> | undefined;

  const persist = (runId: string, state: RunState): void => {
    const snapshot = state.record;
    state.writes = state.writes.then(async () => {
      if (runs.get(runId) !== state) return;
      const saved = await deps.store.save(snapshot);
      if (!saved.ok) {
        deps.logger.warn('live-run: could not write the run record', { runId, error: saved.error.message });
      }
    });
    track(state.writes);
  };

  const mutate = (runId: string, fn: (record: LiveRunRecord) => LiveRunRecord): void => {
    const state = runs.get(runId);
    if (state === undefined) return;
    state.record = { ...fn(state.record), updatedAt: deps.now() };
    persist(runId, state);
  };

  const mutateSpawn = (runId: string, target: LiveRunSpawn, patch: Partial<LiveRunSpawn>): void =>
    mutate(runId, (record) => ({
      ...record,
      spawns: trimHistory(
        record.spawns.map((s) => (s.pid === target.pid && s.startedAt === target.startedAt ? { ...s, ...patch } : s))
      ),
    }));

  return {
    begin(runId, meta) {
      if (runs.has(runId)) return;
      const owner: LiveRunOwner = { pid: process.pid, host: deps.liveness.host, startedAt: processStartedAt };
      const state: RunState = { record: newRecord(runId, meta, owner, deps.now()), writes: Promise.resolve() };
      runs.set(runId, state);
      persist(runId, state);
      ownerIdentity ??= deps.liveness.identify(process.pid);
      ownerMachine ??= deps.liveness.machine();
      track(
        Promise.all([ownerIdentity, ownerMachine]).then(([identity, machine]) => {
          const facts = lateOwnerFacts(identity, machine);
          if (facts !== undefined) mutate(runId, (record) => ({ ...record, owner: { ...record.owner, ...facts } }));
        })
      );
    },

    spawnStarted(runId, child) {
      if (!runs.has(runId)) return undefined;
      const spawn = newSpawn(child, deps.now());
      mutate(runId, (record) => ({ ...record, spawns: trimHistory([...record.spawns, spawn]) }));
      track(
        deps.liveness.identify(child.pid).then((identity) => {
          if (identity !== undefined) mutateSpawn(runId, spawn, { identity });
        })
      );
      return {
        noteSessionId: (sessionId) => mutateSpawn(runId, spawn, { sessionId }),
        exited: () => mutateSpawn(runId, spawn, { exitedAt: deps.now() }),
      };
    },

    end(runId) {
      const state = runs.get(runId);
      if (state === undefined) return;
      runs.delete(runId);
      track(
        state.writes.then(async () => {
          const removed = await deps.store.remove(runId);
          if (!removed.ok) deps.logger.warn('live-run: could not remove the run record', { runId });
        })
      );
    },

    idle,
  };
};
