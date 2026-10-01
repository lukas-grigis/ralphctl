import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRealFsApp, type RealFsApp } from '@tests/helpers/real-fs-app.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { holdFlowLock } from '@tests/helpers/hold-flow-lock.ts';
import {
  FIXED_PROJECT_ID,
  makeApprovedTicket,
  makeDraftSprint,
  makeProject,
  projectId,
} from '@tests/fixtures/domain.ts';

const OTHER = projectId('01900000-0000-7000-8000-0000000000aa');

const exists = async (path: string): Promise<boolean> =>
  fs.stat(path).then(
    () => true,
    () => false
  );

describe('AppDeps.projectRemoval (wired)', () => {
  let app: RealFsApp;
  let owned: Sprint[];
  let foreign: Sprint;
  let memoryDir: string;

  beforeEach(async () => {
    app = await createRealFsApp();
    const { deps, paths } = app;
    await deps.projectRepo.save(makeProject());
    await deps.projectRepo.save(makeProject({ id: OTHER, slug: 'other', displayName: 'Other' }));
    owned = [makeDraftSprint({ name: 'one', tickets: [makeApprovedTicket()] }), makeDraftSprint({ name: 'two' })];
    foreign = makeDraftSprint({ name: 'foreign', projectId: OTHER });
    for (const s of [...owned, foreign]) await deps.sprintRepo.save(s);
    memoryDir = join(String(paths.memoryRoot), `${FIXED_PROJECT_ID}--demo-project`);
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.writeFile(join(memoryDir, 'learnings.ndjson'), 'x');
  });

  afterEach(async () => {
    await app.cleanup();
  });

  it('previews the sprints and memory a cascade would remove', async () => {
    const preview = await app.deps.projectRemoval.preview(FIXED_PROJECT_ID);
    if (!preview.ok) throw preview.error;
    expect(preview.value.sprints.map((s) => [s.name, s.ticketCount])).toEqual([
      ['one', 1],
      ['two', 0],
    ]);
    expect(preview.value.memoryDirs).toBe(1);
    expect(preview.value.bytes).toBeGreaterThan(1);
  });

  it('cascade leaves no orphan sprint dir or memory dir, and spares other projects', async () => {
    const ownedDirs = await Promise.all(owned.map((s) => app.resolveSprintDir(s.id)));
    const r = await app.deps.projectRemoval.remove(FIXED_PROJECT_ID, { cascade: true });
    if (!r.ok) throw r.error;
    expect(r.value).toEqual({ removedSprints: 2, removedMemoryDirs: 1 });

    for (const dir of ownedDirs) expect(await exists(dir)).toBe(false);
    expect(await exists(memoryDir)).toBe(false);
    expect((await app.deps.projectRepo.findById(FIXED_PROJECT_ID)).ok).toBe(false);
    expect(await exists(await app.resolveSprintDir(foreign.id))).toBe(true);

    const scan = await app.deps.housekeeping.scan();
    if (!scan.ok) throw scan.error;
    expect(scan.value.orphanSprints).toEqual([]);
    expect(scan.value.orphanMemoryDirs).toEqual([]);
  });

  it('without cascade removes only the project, as before', async () => {
    const r = await app.deps.projectRemoval.remove(FIXED_PROJECT_ID, { cascade: false });
    if (!r.ok) throw r.error;
    expect(r.value).toEqual({ removedSprints: 0, removedMemoryDirs: 0 });

    for (const s of owned) expect(await exists(await app.resolveSprintDir(s.id))).toBe(true);
    expect(await exists(memoryDir)).toBe(true);
    expect((await app.deps.projectRepo.findById(FIXED_PROJECT_ID)).ok).toBe(false);
  });

  it('touches nothing when the project does not exist', async () => {
    const missing = projectId('01900000-0000-7000-8000-0000000000bb');
    const ghost = makeDraftSprint({ name: 'ghost', projectId: missing });
    await app.deps.sprintRepo.save(ghost);
    const r = await app.deps.projectRemoval.remove(missing, { cascade: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(NotFoundError);
    expect(await exists(await app.resolveSprintDir(ghost.id))).toBe(true);
  });

  it('refuses a cascade while a flow holds its run lock and deletes nothing', async () => {
    const ownedDirs = await Promise.all(owned.map((s) => app.resolveSprintDir(s.id)));
    const lock = await holdFlowLock(app.paths);
    try {
      const r = await app.deps.projectRemoval.remove(FIXED_PROJECT_ID, { cascade: true });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toBeInstanceOf(InvalidStateError);
        expect(r.error.message).toBe('A flow is running — let it finish (or cancel it) before removing data.');
      }
    } finally {
      await lock.release();
    }
    for (const dir of ownedDirs) expect(await exists(dir)).toBe(true);
    expect(await exists(memoryDir)).toBe(true);
    expect((await app.deps.projectRepo.findById(FIXED_PROJECT_ID)).ok).toBe(true);
  });

  it('allows the cascade again once the run lock is released', async () => {
    const lock = await holdFlowLock(app.paths);
    await lock.release();
    const r = await app.deps.projectRemoval.remove(FIXED_PROJECT_ID, { cascade: true });
    if (!r.ok) throw r.error;
    expect(r.value.removedSprints).toBe(2);
  });

  it('still removes the project file alone while a flow is running', async () => {
    const lock = await holdFlowLock(app.paths);
    try {
      const r = await app.deps.projectRemoval.remove(FIXED_PROJECT_ID, { cascade: false });
      if (!r.ok) throw r.error;
    } finally {
      await lock.release();
    }
    for (const s of owned) expect(await exists(await app.resolveSprintDir(s.id))).toBe(true);
    expect((await app.deps.projectRepo.findById(FIXED_PROJECT_ID)).ok).toBe(false);
  });
});
