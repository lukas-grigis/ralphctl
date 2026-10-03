import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRealFsApp, type RealFsApp } from '@tests/helpers/real-fs-app.ts';
import { holdFlowLock } from '@tests/helpers/hold-flow-lock.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { makeDoneSprint, makeDraftSprint, makeProject, projectId } from '@tests/fixtures/domain.ts';

const GONE = projectId('01900000-0000-7000-8000-0000000000ff');

const exists = async (path: string): Promise<boolean> =>
  fs.stat(path).then(
    () => true,
    () => false
  );

describe('AppDeps.housekeeping (wired)', () => {
  let app: RealFsApp;

  beforeEach(async () => {
    app = await createRealFsApp();
  });

  afterEach(async () => {
    await app.cleanup();
  });

  it('purges one orphan sprint and leaves every other group on disk', async () => {
    const { deps, paths } = app;
    await deps.projectRepo.save(makeProject());
    const ghostA = makeDraftSprint({ name: 'ghost-a', projectId: GONE });
    const ghostB = makeDraftSprint({ name: 'ghost-b', projectId: GONE });
    const done = makeDoneSprint();
    for (const s of [ghostA, ghostB, done]) await deps.sprintRepo.save(s);
    const memoryDir = join(String(paths.memoryRoot), `${GONE}--gone`);
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.writeFile(join(memoryDir, 'learnings.ndjson'), 'x');
    const runDir = join(String(paths.runsRoot), 'readiness', '2026-01-01T00-00-00-000Z-aaaaaa');
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(join(runDir, 'body.txt'), 'x');

    const scanned = await deps.housekeeping.scan();
    if (!scanned.ok) throw scanned.error;
    expect(scanned.value.orphanSprints.map((s) => s.name)).toEqual(['ghost-a', 'ghost-b']);
    const ghostADir = await app.resolveSprintDir(ghostA.id);

    const purged = await deps.housekeeping.purge([scanned.value.orphanSprints[0]!]);
    if (!purged.ok) throw purged.error;
    expect(purged.value.removed).toHaveLength(1);

    expect(await exists(ghostADir)).toBe(false);
    expect(await exists(await app.resolveSprintDir(ghostB.id))).toBe(true);
    expect(await exists(await app.resolveSprintDir(done.id))).toBe(true);
    expect(await exists(memoryDir)).toBe(true);
    expect(await exists(runDir)).toBe(true);

    const rescanned = await deps.housekeeping.scan();
    if (!rescanned.ok) throw rescanned.error;
    expect(rescanned.value.orphanSprints.map((s) => s.name)).toEqual(['ghost-b']);
    expect(rescanned.value.orphanMemoryDirs).toHaveLength(1);
    expect(rescanned.value.staleDoneSprints).toHaveLength(1);
    expect(rescanned.value.staleRuns).toHaveLength(1);
  });

  it('removes an orphan memory dir in both its slugged and legacy bare forms', async () => {
    const root = String(app.paths.memoryRoot);
    await fs.mkdir(join(root, `${GONE}--gone`), { recursive: true });
    await fs.mkdir(join(root, String(GONE)), { recursive: true });

    const scanned = await app.deps.housekeeping.scan();
    if (!scanned.ok) throw scanned.error;
    const purged = await app.deps.housekeeping.purge(scanned.value.orphanMemoryDirs);
    if (!purged.ok) throw purged.error;

    expect(await fs.readdir(root)).toEqual([]);
  });

  it('scans but refuses to purge while a flow holds its run lock', async () => {
    const ghost = makeDraftSprint({ name: 'ghost', projectId: GONE });
    await app.deps.sprintRepo.save(ghost);
    const ghostDir = await app.resolveSprintDir(ghost.id);
    const lock = await holdFlowLock(app.paths);
    try {
      const scanned = await app.deps.housekeeping.scan();
      if (!scanned.ok) throw scanned.error;
      expect(scanned.value.orphanSprints).toHaveLength(1);
      const purged = await app.deps.housekeeping.purge(scanned.value.orphanSprints);
      expect(purged.ok).toBe(false);
      if (!purged.ok) expect(purged.error).toBeInstanceOf(InvalidStateError);
    } finally {
      await lock.release();
    }
    expect(await exists(ghostDir)).toBe(true);
  });
});
