import { promises as fs } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ensureStorageRoots,
  storagePathsFromRoot,
  type StoragePaths,
} from '@src/application/bootstrap/storage-paths.ts';
import { scanHousekeepingUseCase } from '@src/business/housekeeping/scan-housekeeping.ts';
import { createFsHousekeepingDisk } from '@src/integration/persistence/housekeeping/fs-housekeeping-disk.ts';
import { createFsProjectRepository } from '@src/integration/persistence/project/repository.ts';
import { createFsSprintRepository } from '@src/integration/persistence/sprint/repository.ts';
import { resolveSprintDir } from '@src/integration/persistence/storage.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import {
  FIXED_PROJECT_ID,
  isoTimestamp,
  makeDoneSprint,
  makeDraftSprint,
  makeProject,
  projectId,
} from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { makeTmpRoot } from '@tests/fixtures/tmp-root.ts';

const ORPHAN_PROJECT_ID = projectId('01900000-0000-7000-8000-0000000000ff');
// makeDoneSprint seals at 2026-05-08T12:00Z — 54 days before this.
const NOW = isoTimestamp('2026-07-01T12:00:00.000Z');

const writeFile = async (path: string, content: string): Promise<void> => {
  await fs.mkdir(join(path, '..'), { recursive: true });
  await fs.writeFile(path, content);
};

const listTree = async (root: string): Promise<string[]> => {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) await walk(p);
      else out.push(relative(root, p));
    }
  };
  await walk(root);
  return out.sort();
};

const sprintJsonBytes = async (paths: StoragePaths, sprint: Sprint): Promise<number> => {
  const dir = await resolveSprintDir(paths.dataRoot, sprint.id);
  if (dir === undefined) throw new Error('sprint dir missing');
  return (await fs.stat(join(dir, 'sprint.json'))).size;
};

describe('scanHousekeepingUseCase over a real data root', () => {
  let paths: StoragePaths;
  let cleanup: () => Promise<void>;
  let live: Sprint;
  let done: Sprint;
  let orphan: Sprint;

  beforeEach(async () => {
    const tmp = await makeTmpRoot();
    cleanup = tmp.cleanup;
    const resolved = storagePathsFromRoot(tmp.root);
    if (!resolved.ok) throw resolved.error;
    paths = resolved.value;
    await ensureStorageRoots(paths);

    const projectRepo = createFsProjectRepository({ root: paths.dataRoot });
    const sprintRepo = createFsSprintRepository({ root: paths.dataRoot });
    await projectRepo.save(makeProject());
    live = makeDraftSprint({ name: 'live' });
    done = makeDoneSprint();
    orphan = makeDraftSprint({ name: 'ghost', projectId: ORPHAN_PROJECT_ID });
    for (const s of [live, done, orphan]) await sprintRepo.save(s);

    const memory = String(paths.memoryRoot);
    await writeFile(join(memory, `${FIXED_PROJECT_ID}--demo-project`, 'learnings.ndjson'), 'kept\n');
    await writeFile(join(memory, `${ORPHAN_PROJECT_ID}--gone`, 'learnings.ndjson'), '0123456789');
    await writeFile(join(memory, '.DS_Store'), 'x');

    const runs = String(paths.runsRoot);
    await writeFile(join(runs, 'detect-scripts', '2026-01-01T00-00-00-000Z-aaaaaa', 'prompt.md'), 'old run');
    await writeFile(join(runs, 'readiness', '2026-06-30T00-00-00-000Z-bbbbbb', 'body.txt'), 'new');
    await writeFile(join(runs, 'readiness', 'hand-made', 'notes.txt'), 'no stamp');
  });

  afterEach(async () => {
    await cleanup();
  });

  const scan = (staleAfterDays?: number) =>
    scanHousekeepingUseCase({
      projectRepo: createFsProjectRepository({ root: paths.dataRoot }),
      sprintRepo: createFsSprintRepository({ root: paths.dataRoot }),
      disk: createFsHousekeepingDisk(paths),
      now: NOW,
      ...(staleAfterDays !== undefined ? { staleAfterDays } : {}),
      logger: noopLogger,
    });

  it('groups orphan sprints, orphan memory dirs, stale done sprints and stale runs with byte sizes', async () => {
    const result = await scan();
    if (!result.ok) throw result.error;
    const s = result.value;

    expect(s.staleAfterDays).toBe(30);
    expect(s.orphanSprints).toEqual([
      {
        kind: 'orphan-sprint',
        sprintId: orphan.id,
        projectId: ORPHAN_PROJECT_ID,
        name: 'ghost',
        status: 'draft',
        ticketCount: 0,
        bytes: await sprintJsonBytes(paths, orphan),
      },
    ]);
    expect(s.staleDoneSprints).toHaveLength(1);
    expect(s.staleDoneSprints[0]).toMatchObject({ kind: 'stale-sprint', sprintId: done.id });
    expect(s.staleDoneSprints[0]?.bytes).toBe(await sprintJsonBytes(paths, done));
    expect(s.orphanMemoryDirs).toEqual([
      { kind: 'orphan-memory', projectId: ORPHAN_PROJECT_ID, name: `${ORPHAN_PROJECT_ID}--gone`, bytes: 10 },
    ]);
    expect(s.staleRuns).toEqual([
      {
        kind: 'stale-run',
        flow: 'detect-scripts',
        runId: '2026-01-01T00-00-00-000Z-aaaaaa',
        startedAt: '2026-01-01T00:00:00.000Z',
        bytes: 7,
      },
    ]);
    expect(s.runTotals).toEqual({ count: 3, bytes: 7 + 3 + 8 });
    expect(s.reclaimableBytes).toBe(s.orphanSprints[0]!.bytes + s.staleDoneSprints[0]!.bytes + 10 + 7);
  });

  it('honours a custom stale threshold', async () => {
    const result = await scan(365);
    if (!result.ok) throw result.error;
    expect(result.value.staleDoneSprints).toEqual([]);
    expect(result.value.staleRuns).toEqual([]);
    expect(result.value.orphanSprints).toHaveLength(1);
  });

  it('deletes nothing', async () => {
    const before = await listTree(String(paths.appRoot));
    const result = await scan(0);
    expect(result.ok).toBe(true);
    expect(await listTree(String(paths.appRoot))).toEqual(before);
  });

  it('rejects a negative threshold', async () => {
    const result = await scan(-1);
    expect(result.ok).toBe(false);
  });
});
