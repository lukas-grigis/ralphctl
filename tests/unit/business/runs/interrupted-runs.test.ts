import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import type {
  LiveRunRecord,
  LiveRunSpawn,
  LiveRunStore,
  ProcessIdentity,
  ProcessLiveness,
} from '@src/business/runs/live-run.ts';
import { createDetectInterruptedRuns } from '@src/business/runs/detect-interrupted-runs.ts';
import { createReapInterruptedRuns } from '@src/business/runs/reap-interrupted-runs.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';

const HOST = 'this-box';
const ID_A: ProcessIdentity = { startedAt: 'Thu Oct 1 21:00:00 2026', command: 'claude' };
const ID_B: ProcessIdentity = { startedAt: 'Thu Oct 1 22:00:00 2026', command: 'vim' };

const spawn = (pid: number, overrides: Partial<LiveRunSpawn> = {}, grouped = true): LiveRunSpawn => ({
  pid,
  ...(grouped ? { pgid: pid } : {}),
  provider: 'claude-code',
  command: 'claude',
  cwd: '/repo',
  signalsFile: '/s/rounds/1/generator/signals.json',
  startedAt: '2026-10-01T19:00:00.000Z',
  identity: ID_A,
  ...overrides,
});

const record = (runId: string, ownerPid: number, overrides: Partial<LiveRunRecord> = {}): LiveRunRecord => ({
  version: 1,
  runId,
  flowId: 'implement',
  owner: { pid: ownerPid, host: HOST, startedAt: '2026-10-01T18:00:00.000Z' },
  startedAt: '2026-10-01T19:00:00.000Z',
  updatedAt: '2026-10-01T19:00:00.000Z',
  spawns: [],
  ...overrides,
});

interface World {
  readonly alive: ReadonlySet<number>;
  readonly groups?: ReadonlySet<number>;
  readonly identities?: ReadonlyMap<number, ProcessIdentity>;
}

const livenessOf = (world: World): ProcessLiveness => ({
  host: HOST,
  isAlive: (pid) => world.alive.has(pid),
  isGroupAlive: (pgid) => world.groups?.has(pgid) ?? false,
  identify: (pid) => Promise.resolve(world.alive.has(pid) ? world.identities?.get(pid) : undefined),
});

const storeOf = (records: readonly LiveRunRecord[]): LiveRunStore & { readonly saved: LiveRunRecord[] } => {
  const saved: LiveRunRecord[] = [];
  return {
    saved,
    list: () => Promise.resolve(Result.ok(records) as Result<readonly LiveRunRecord[], StorageError>),
    save: (r) => {
      saved.push(r);
      return Promise.resolve(Result.ok(undefined) as Result<void, StorageError>);
    },
    remove: () => Promise.resolve(Result.ok(undefined) as Result<void, StorageError>),
  };
};

const ids = (value: unknown): unknown =>
  Array.isArray(value) ? value.map((r: { record: LiveRunRecord }) => r.record.runId) : value;

describe('detectInterruptedRuns', () => {
  it('reports runs whose owner is dead on this host, with the spawns still running at the time', async () => {
    const detect = createDetectInterruptedRuns({
      store: storeOf([
        record('dead-owner', 11, { spawns: [spawn(21), spawn(22, { exitedAt: '2026-10-01T19:01:00.000Z' })] }),
        record('live-owner', 12),
        record('other-host', 13, { owner: { pid: 13, host: 'elsewhere', startedAt: 'x' } }),
      ]),
      liveness: livenessOf({ alive: new Set([12]) }),
    });

    const result = await detect.execute();

    expect(result.ok && ids(result.value)).toEqual(['dead-owner']);
    expect(result.ok && result.value[0]?.liveSpawns.map((s) => s.pid)).toEqual([21]);
  });

  it('treats a live owner pid that is no longer the recorded process as interrupted', async () => {
    const detect = createDetectInterruptedRuns({
      store: storeOf([
        record('recycled', 11, { owner: { pid: 11, host: HOST, startedAt: 'x', identity: ID_A } }),
        record('same-process', 12, { owner: { pid: 12, host: HOST, startedAt: 'x', identity: ID_A } }),
        record('unidentifiable', 13, { owner: { pid: 13, host: HOST, startedAt: 'x', identity: ID_A } }),
      ]),
      liveness: livenessOf({
        alive: new Set([11, 12, 13]),
        identities: new Map([
          [11, ID_B],
          [12, ID_A],
        ]),
      }),
    });

    const result = await detect.execute();

    expect(result.ok && ids(result.value)).toEqual(['recycled']);
  });
});

describe('reapInterruptedRuns', () => {
  const reaperFor = (records: readonly LiveRunRecord[], world: World) => {
    const store = storeOf(records);
    const liveness = livenessOf(world);
    const terminated: number[] = [];
    const reap = createReapInterruptedRuns({
      detect: createDetectInterruptedRuns({ store, liveness }),
      store,
      liveness,
      terminator: { terminateGroup: (pgid) => terminated.push(pgid) },
      now: () => '2026-10-01T20:00:00.000Z',
      logger: noopLogger,
    });
    return { reap, store, terminated };
  };

  it('kills a group whose leader is gone, and a live leader only when it is still the recorded process', async () => {
    const { reap, store, terminated } = reaperFor(
      [
        record('crashed', 1, {
          spawns: [
            spawn(31), // leader gone, group alive → ours
            spawn(32), // leader alive, same identity → ours
            spawn(33), // leader alive, recycled pid → spared
            spawn(34), // group gone → nothing to do
            spawn(35, {}, false), // no group (Windows) → nothing to do
          ],
        }),
      ],
      {
        alive: new Set([32, 33]),
        groups: new Set([31, 32, 33]),
        identities: new Map([
          [32, ID_A],
          [33, ID_B],
        ]),
      }
    );

    const result = await reap.execute();

    expect(terminated).toEqual([31, 32]);
    expect(result.ok && result.value).toEqual({ runIds: ['crashed'], reapedGroups: [31, 32] });
    expect(store.saved).toEqual([expect.objectContaining({ runId: 'crashed', reapedAt: '2026-10-01T20:00:00.000Z' })]);
  });

  it('skips a record an earlier boot already reaped', async () => {
    const { reap, terminated, store } = reaperFor(
      [record('done', 1, { reapedAt: '2026-10-01T19:30:00.000Z', spawns: [spawn(31)] })],
      { alive: new Set(), groups: new Set([31]) }
    );

    const result = await reap.execute();

    expect(terminated).toEqual([]);
    expect(store.saved).toEqual([]);
    expect(result.ok && result.value.runIds).toEqual([]);
  });
});
