import { describe, expect, it } from 'vitest';
import { createInProcessRuns } from '@src/application/session/in-process-runs.ts';
import { createGatedRunner } from '@tests/helpers/gated-runner.ts';

describe('createInProcessRuns', () => {
  it('reports no activity before anything is tracked', async () => {
    expect(await createInProcessRuns().anyRunActive()).toBe(false);
  });

  it('counts a tracked runner as active from registration until it completes', async () => {
    const runs = createInProcessRuns();
    const { runner, finish } = createGatedRunner();
    runs.track(runner);
    expect(await runs.anyRunActive()).toBe(true);

    const started = runner.start();
    expect(await runs.anyRunActive()).toBe(true);
    finish();
    await started;
    expect(await runs.anyRunActive()).toBe(false);
  });

  it('drops an aborted runner', async () => {
    const runs = createInProcessRuns();
    const { runner } = createGatedRunner();
    runs.track(runner);
    runner.abort('test');
    expect(await runs.anyRunActive()).toBe(false);
  });

  it('ignores a runner that already settled', async () => {
    const runs = createInProcessRuns();
    const { runner, finish } = createGatedRunner();
    finish();
    await runner.start();
    runs.track(runner);
    expect(await runs.anyRunActive()).toBe(false);
  });

  it('stays active while any one of several runners is live', async () => {
    const runs = createInProcessRuns();
    const a = createGatedRunner('a');
    const b = createGatedRunner('b');
    runs.track(a.runner);
    runs.track(b.runner);
    const startedA = a.runner.start();
    a.finish();
    await startedA;
    expect(await runs.anyRunActive()).toBe(true);
    b.runner.abort('test');
    expect(await runs.anyRunActive()).toBe(false);
  });
});

describe('createInProcessRuns — flush', () => {
  it('waits for the recorder to go idle', async () => {
    let idled = false;
    const runs = createInProcessRuns({
      recorder: {
        begin: () => undefined,
        end: () => undefined,
        idle: () => new Promise<void>((resolve) => setTimeout(() => ((idled = true), resolve()), 5)),
      },
    });
    await runs.flush();
    expect(idled).toBe(true);
  });

  it('gives up after timeoutMs when a record write never lands, so quitting cannot hang', async () => {
    const runs = createInProcessRuns({
      recorder: { begin: () => undefined, end: () => undefined, idle: () => new Promise<void>(() => undefined) },
    });
    await expect(runs.flush({ timeoutMs: 10 })).resolves.toBeUndefined();
  });
});
