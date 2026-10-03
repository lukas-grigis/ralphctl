import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { Element } from '@src/application/chain/element.ts';
import { createRunner } from '@src/application/chain/run/runner.ts';
import { rootSessionId } from '@src/application/session/session.ts';
import { createInProcessRuns } from '@src/application/session/in-process-runs.ts';
import { createLiveRunRecorder } from '@src/application/session/live-run-recorder.ts';
import { createRunChildRegistry } from '@src/application/session/run-child-registry.ts';
import type { ProcessLiveness } from '@src/business/runs/live-run.ts';
import type { RegisteredChild } from '@src/integration/ai/providers/_engine/child-registry.ts';
import { createFsLiveRunStore, liveRunsDir } from '@src/integration/persistence/live-run/fs-live-run-store.ts';
import { absolutePath } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';

const liveness: ProcessLiveness = {
  host: 'this-box',
  selfPid: process.pid,
  machine: () => Promise.resolve({ host: 'this-box', machineId: 'machine-1' }),
  isAlive: () => true,
  isGroupAlive: () => false,
  identify: (pid) => Promise.resolve({ startedAt: `start-${String(pid)}`, command: 'claude' }),
};

const CHILD: RegisteredChild = {
  pid: 4242,
  pgid: 4242,
  provider: 'claude-code',
  command: 'claude',
  cwd: '/repo',
  role: 'generator',
  signalsFile: '/sprint/implement/t1/rounds/2/generator/signals.json',
};

describe('live-run records', () => {
  let stateRoot: string;
  let watched: string[];

  const build = () => {
    const store = createFsLiveRunStore({ stateRoot: absolutePath(stateRoot) });
    const recorder = createLiveRunRecorder({
      store,
      liveness,
      now: () => '2026-10-01T20:00:00.000Z',
      logger: noopLogger,
    });
    const children = createRunChildRegistry({
      reaper: { watch: (g) => watched.push(`+${String(g)}`), unwatch: (g) => watched.push(`-${String(g)}`) },
      recorder,
      runIdOf: rootSessionId,
    });
    return { store, recorder, children, runs: createInProcessRuns({ recorder, children }) };
  };

  const recordFile = (runId: string): string => join(liveRunsDir(absolutePath(stateRoot)), `${runId}.json`);
  const readRecord = async (runId: string): Promise<Record<string, unknown>> =>
    JSON.parse(await fs.readFile(recordFile(runId), 'utf8')) as Record<string, unknown>;

  beforeEach(async () => {
    stateRoot = await fs.mkdtemp(join(tmpdir(), 'ralphctl-liveruns-'));
    watched = [];
  });

  it('records a tracked run, its spawns as they come and go, and removes the record when the run settles', async () => {
    const { recorder, children, runs } = build();
    let releaseGate!: () => void;
    const gate = new Promise<void>((r) => (releaseGate = r));
    let snapshot: Record<string, unknown> | undefined;
    const element: Element<object> = {
      name: 'spawns',
      execute: async (ctx) => {
        const handle = children.register(CHILD);
        handle.noteSessionId('sess-1');
        await recorder.idle();
        snapshot = await readRecord('r-1');
        await gate;
        handle.release();
        return Result.ok({ ctx, trace: [] });
      },
    };
    const runner = createRunner({ id: 'r-1', element, initialCtx: {} });
    runs.track(runner, { flowId: 'implement', sprintId: 'sprint-9' });
    const started = runner.start();
    await new Promise((r) => setTimeout(r, 20));
    releaseGate();
    await started;
    await recorder.idle();

    expect(snapshot).toMatchObject({
      runId: 'r-1',
      flowId: 'implement',
      sprintId: 'sprint-9',
      owner: { pid: process.pid, host: 'this-box', identity: { startedAt: `start-${String(process.pid)}` } },
      spawns: [
        {
          pid: 4242,
          pgid: 4242,
          provider: 'claude-code',
          role: 'generator',
          round: 2,
          sessionId: 'sess-1',
          identity: { startedAt: 'start-4242', command: 'claude' },
        },
      ],
    });
    expect(watched).toEqual(['+4242', '-4242']);
    await expect(fs.access(recordFile('r-1'))).rejects.toThrow();
  });

  it('abortAll aborts every live run and resolves only after the children exited and the records are gone', async () => {
    const { children, runs } = build();
    const order: string[] = [];
    const element: Element<object> = {
      name: 'waits-for-abort',
      execute: async (ctx, signal) => {
        const handle = children.register(CHILD);
        await new Promise<void>((r) => signal?.addEventListener('abort', () => r(), { once: true }));
        // The CLI takes a moment to die after the kill.
        await new Promise((r) => setTimeout(r, 30));
        order.push('child exited');
        handle.release();
        return Result.ok({ ctx, trace: [] });
      },
    };
    const a = createRunner({ id: 'r-a', element, initialCtx: {} });
    const b = createRunner({ id: 'r-b', element, initialCtx: {} });
    runs.track(a, { flowId: 'implement' });
    runs.track(b, { flowId: 'review' });
    void a.start();
    void b.start();
    await new Promise((r) => setTimeout(r, 10));
    expect(runs.liveCount()).toBe(2);

    await runs.abortAll();
    order.push('abortAll resolved');

    expect(order).toEqual(['child exited', 'child exited', 'abortAll resolved']);
    expect(runs.liveCount()).toBe(0);
    expect(children.liveChildren()).toBe(0);
    expect(await fs.readdir(liveRunsDir(absolutePath(stateRoot)))).toEqual([]);
  });

  it('abortAll stops waiting after the bound, kills the registered groups and says which runs were stuck', async () => {
    const store = createFsLiveRunStore({ stateRoot: absolutePath(stateRoot) });
    const recorder = createLiveRunRecorder({ store, liveness, now: () => 'now', logger: noopLogger });
    const killed: Array<number | undefined> = [];
    const children = createRunChildRegistry({
      reaper: { watch: () => undefined, unwatch: () => undefined },
      recorder,
      runIdOf: rootSessionId,
      kill: (child) => {
        killed.push(child.pgid);
        return true;
      },
    });
    const runs = createInProcessRuns({ recorder, children });
    const deaf: Element<object> = {
      name: 'ignores-abort',
      execute: () => {
        children.register(CHILD);
        return new Promise(() => undefined);
      },
    };
    const runner = createRunner({ id: 'r-deaf', element: deaf, initialCtx: {} });
    runs.track(runner, { flowId: 'implement' });
    void runner.start();
    await new Promise((r) => setTimeout(r, 10));

    const outcome = await runs.abortAll('quit', { timeoutMs: 40 });

    expect(outcome).toEqual({ runs: 1, forced: true, stuckFlows: ['implement'], killed: 1 });
    expect(killed).toEqual([4242]);
  });

  it('settles the attempts of an implement run its caller stopped, and only such a run', async () => {
    const settleAbandoned = vi.fn(() => Promise.resolve());
    const runs = createInProcessRuns({ settleAbandoned, now: () => 1_000 });
    const waitsForAbort: Element<object> = {
      name: 'waits',
      execute: async (_ctx, signal) => {
        await new Promise<void>((r) => signal?.addEventListener('abort', () => r(), { once: true }));
        return Result.error({ error: new AbortError({ elementName: 'waits' }), trace: [] });
      },
    };
    const raisesAbort: Element<object> = {
      name: 'raises',
      execute: () =>
        Promise.resolve(
          Result.error({ error: new AbortError({ elementName: 'prompt', reason: 'operator said abort' }), trace: [] })
        ),
    };
    const stopped = createRunner({ id: 'r-stopped', element: waitsForAbort, initialCtx: {} });
    const selfAborted = createRunner({ id: 'r-self', element: raisesAbort, initialCtx: {} });
    const plan = createRunner({ id: 'r-plan', element: waitsForAbort, initialCtx: {} });
    runs.track(stopped, { flowId: 'implement', sprintId: 's-1' });
    runs.track(selfAborted, { flowId: 'implement', sprintId: 's-2' });
    runs.track(plan, { flowId: 'plan', sprintId: 's-3' });
    void stopped.start();
    await selfAborted.start();
    void plan.start();
    await new Promise((r) => setTimeout(r, 5));

    const outcome = await runs.abortAll('quit');

    expect(outcome).toEqual({ runs: 2, forced: false, stuckFlows: [], killed: 0 });
    expect(settleAbandoned).toHaveBeenCalledTimes(1);
    expect(settleAbandoned).toHaveBeenCalledWith({ sprintId: 's-1', since: 1_000 });
  });

  it('a spawn outside any tracked run is still handed to the reaper but touches no record', async () => {
    const { children, recorder } = build();
    const handle = children.register(CHILD);
    handle.release();
    await recorder.idle();

    expect(watched).toEqual(['+4242', '-4242']);
    await expect(fs.readdir(liveRunsDir(absolutePath(stateRoot)))).rejects.toThrow();
  });
});

describe('createFsLiveRunStore', () => {
  it('skips unreadable files and refuses a run id that could escape the directory', async () => {
    const stateRoot = absolutePath(await fs.mkdtemp(join(tmpdir(), 'ralphctl-runstore-')));
    const store = createFsLiveRunStore({ stateRoot });
    await fs.mkdir(liveRunsDir(stateRoot), { recursive: true });
    await fs.writeFile(join(liveRunsDir(stateRoot), 'garbage.json'), '{ not json');
    const good = {
      version: 1,
      runId: 'r-ok',
      flowId: 'plan',
      owner: { pid: 1, host: 'h', startedAt: 's' },
      startedAt: 's',
      updatedAt: 's',
      spawns: [],
      futureField: 'kept readable',
    };
    expect((await store.save(good)).ok).toBe(true);

    const listed = await store.list();
    expect(listed.ok && listed.value.map((r) => r.runId)).toEqual(['r-ok']);
    expect((await store.save({ ...good, runId: '../escape' })).ok).toBe(false);
    expect((await store.remove('r-ok')).ok).toBe(true);
    expect((await store.remove('r-ok')).ok).toBe(true);
  });
});
