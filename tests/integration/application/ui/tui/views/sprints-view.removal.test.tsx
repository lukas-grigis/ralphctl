/**
 * SprintsView removal over a real tmpdir app: Yes removes the sprint, but not while a flow run is active in this
 * process or holds its lock in another.
 */

import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SprintsView } from '@src/application/ui/tui/views/sprints-view.tsx';
import { createRealFsApp, type RealFsApp } from '@tests/helpers/real-fs-app.ts';
import { holdFlowLock } from '@tests/helpers/hold-flow-lock.ts';
import { createGatedRunner } from '@tests/helpers/gated-runner.ts';
import { makeDraftSprint } from '@tests/fixtures/domain.ts';
import { waitForPredicate } from '@tests/integration/application/ui/tui/_wait.ts';
import { renderView, waitForViewReady } from '@tests/integration/application/ui/tui/_harness.tsx';

const exists = async (path: string): Promise<boolean> =>
  fs.stat(path).then(
    () => true,
    () => false
  );

describe('SprintsView removal', () => {
  let app: RealFsApp;
  let sprintDir: string;

  beforeEach(async () => {
    app = await createRealFsApp();
    const sprint = makeDraftSprint({ name: 'Doomed Sprint' });
    await app.deps.sprintRepo.save(sprint);
    sprintDir = await app.resolveSprintDir(sprint.id);
  });

  afterEach(async () => {
    await app.cleanup();
  });

  const confirmDelete = async (): Promise<ReturnType<typeof renderView>['result']> => {
    const { result } = renderView(<SprintsView />, { deps: app.deps, initial: { id: 'sprints' } });
    await waitForViewReady(result, (f) => f.includes('Doomed Sprint'));
    result.stdin.write('d');
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('Remove sprint'));
    result.stdin.write('y');
    return result;
  };

  it('Yes removes the sprint directory', async () => {
    const result = await confirmDelete();
    await waitForPredicate(() => !(result.lastFrame() ?? '').includes('Doomed Sprint'));
    expect(await exists(sprintDir)).toBe(false);
    result.unmount();
  });

  it('Yes while another process holds a flow lock shows the refusal and keeps the sprint', async () => {
    const lock = await holdFlowLock(app.paths);
    try {
      const result = await confirmDelete();
      await waitForPredicate(() => (result.lastFrame() ?? '').includes('A flow is running'));
      expect(await exists(sprintDir)).toBe(true);
      result.unmount();
    } finally {
      await lock.release();
    }
  });

  it('Yes while a lock-free flow runs in this process shows the refusal and keeps the sprint', async () => {
    const { runner, finish } = createGatedRunner();
    app.deps.inProcessRuns.track(runner);
    const started = runner.start();
    try {
      const result = await confirmDelete();
      await waitForPredicate(() => (result.lastFrame() ?? '').includes('A flow is running'));
      expect(await exists(sprintDir)).toBe(true);
      result.unmount();
    } finally {
      finish();
      await started;
    }
  });
});
