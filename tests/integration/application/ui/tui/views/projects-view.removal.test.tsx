/**
 * ProjectsView removal over a real tmpdir app: the project goes on the first Yes; the cascade
 * (its sprints and memory) only on a second, separate Yes — No keeps today's orphaning behaviour.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectsView } from '@src/application/ui/tui/views/projects-view.tsx';
import { createRealFsApp, type RealFsApp } from '@tests/helpers/real-fs-app.ts';
import { holdFlowLock } from '@tests/helpers/hold-flow-lock.ts';
import { FIXED_PROJECT_ID, makeDraftSprint, makeProject } from '@tests/fixtures/domain.ts';
import { waitForPredicate } from '@tests/integration/application/ui/tui/_wait.ts';
import { renderView, waitForViewReady } from '@tests/integration/application/ui/tui/_harness.tsx';

const exists = async (path: string): Promise<boolean> =>
  fs.stat(path).then(
    () => true,
    () => false
  );

describe('ProjectsView removal', () => {
  let app: RealFsApp;
  let sprintDir: string;
  let memoryDir: string;

  beforeEach(async () => {
    app = await createRealFsApp();
    await app.deps.projectRepo.save(makeProject({ displayName: 'Demo Project' }));
    const sprint = makeDraftSprint({ name: 'owned' });
    await app.deps.sprintRepo.save(sprint);
    sprintDir = await app.resolveSprintDir(sprint.id);
    memoryDir = join(String(app.paths.memoryRoot), `${FIXED_PROJECT_ID}--demo-project`);
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.writeFile(join(memoryDir, 'learnings.ndjson'), 'x');
  });

  afterEach(async () => {
    await app.cleanup();
  });

  const open = async (): Promise<ReturnType<typeof renderView>['result']> => {
    const { result } = renderView(<ProjectsView />, { deps: app.deps, initial: { id: 'projects' } });
    await waitForViewReady(result, (f) => f.includes('Demo Project'));
    result.stdin.write('d');
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('Remove project'));
    result.stdin.write('y');
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('Also remove its 1 sprint and memory'));
    return result;
  };

  it('Yes removes the sprints and memory too — no orphan is left', async () => {
    const result = await open();
    result.stdin.write('y');
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('No projects yet'));
    // The empty state replaces the list body, so the success toast must live outside it.
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('removed Demo Project'));
    expect(await exists(sprintDir)).toBe(false);
    expect(await exists(memoryDir)).toBe(false);
    const scan = await app.deps.housekeeping.scan();
    if (!scan.ok) throw scan.error;
    expect(scan.value.orphanSprints).toEqual([]);
    expect(scan.value.orphanMemoryDirs).toEqual([]);
    result.unmount();
  });

  it('No removes only the project and leaves its sprints and memory as orphans', async () => {
    const result = await open();
    result.stdin.write('n');
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('No projects yet'));
    expect(await exists(sprintDir)).toBe(true);
    expect(await exists(memoryDir)).toBe(true);
    const scan = await app.deps.housekeeping.scan();
    if (!scan.ok) throw scan.error;
    expect(scan.value.orphanSprints).toHaveLength(1);
    result.unmount();
  });

  it('Yes while a flow is running shows the refusal and keeps the project and its sprints', async () => {
    const lock = await holdFlowLock(app.paths);
    try {
      const result = await open();
      result.stdin.write('y');
      await waitForPredicate(() => (result.lastFrame() ?? '').includes('A flow is running'));
      expect(result.lastFrame() ?? '').toContain('Demo Project');
      expect(await exists(sprintDir)).toBe(true);
      expect(await exists(memoryDir)).toBe(true);
      result.unmount();
    } finally {
      await lock.release();
    }
  });
});

describe('ProjectsView removal — memory only', () => {
  it('names only what was removed: never "0 sprints"', async () => {
    const app = await createRealFsApp();
    try {
      await app.deps.projectRepo.save(makeProject({ displayName: 'Demo Project' }));
      const memoryDir = join(String(app.paths.memoryRoot), `${FIXED_PROJECT_ID}--demo-project`);
      await fs.mkdir(memoryDir, { recursive: true });
      await fs.writeFile(join(memoryDir, 'learnings.ndjson'), 'x');
      const { result } = renderView(<ProjectsView />, { deps: app.deps, initial: { id: 'projects' } });
      await waitForViewReady(result, (f) => f.includes('Demo Project'));
      result.stdin.write('d');
      await waitForPredicate(() => (result.lastFrame() ?? '').includes('Remove project'));
      result.stdin.write('y');
      await waitForPredicate(() => (result.lastFrame() ?? '').includes('Also remove its memory'));
      expect(result.lastFrame() ?? '').not.toContain('0 sprints');
      result.stdin.write('y');
      await waitForPredicate(() => (result.lastFrame() ?? '').includes('removed Demo Project and its memory'));
      expect(result.lastFrame() ?? '').not.toContain('0 sprints');
      result.unmount();
    } finally {
      await app.cleanup();
    }
  });
});
