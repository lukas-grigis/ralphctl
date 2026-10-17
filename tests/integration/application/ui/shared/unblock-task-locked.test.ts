import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { FileLocker } from '@src/integration/io/file-locker.ts';
import { repoLockFile } from '@src/integration/io/lock-paths.ts';
import { ensureCanonicalSprintDir, createFsSprintRepository } from '@src/integration/persistence/sprint/repository.ts';
import { createFsTaskRepository } from '@src/integration/persistence/task/repository.ts';
import { toJsonSprint } from '@src/integration/persistence/sprint/sprint.schema.ts';
import { storagePathsFromRoot } from '@src/application/bootstrap/storage-paths.ts';
import { sprintsDir } from '@src/integration/persistence/storage.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { unblockTaskLocked } from '@src/application/ui/shared/unblock-task-locked.ts';
import { makeDraftSprintBundle, makeTodoTask } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { makeTmpRoot } from '@tests/fixtures/tmp-root.ts';

describe('unblockTaskLocked', () => {
  let root: AbsolutePath;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const tmp = await makeTmpRoot();
    root = tmp.root;
    cleanup = tmp.cleanup;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanup();
  });

  it('takes the same sprint lock as a launcher when the legacy dir cannot be renamed', async () => {
    const storage = storagePathsFromRoot(root);
    if (!storage.ok) throw storage.error;
    const dataRoot = storage.value.dataRoot;
    const { sprint } = makeDraftSprintBundle({ slug: 'cool-sprint' });
    const task = makeTodoTask();
    const legacyDir = join(sprintsDir(dataRoot), String(sprint.id));
    await fs.mkdir(legacyDir, { recursive: true });
    await fs.writeFile(join(legacyDir, 'sprint.json'), JSON.stringify(toJsonSprint(sprint)), 'utf8');
    await createFsTaskRepository({ root: dataRoot }).saveAll(sprint.id, [task]);

    // A Windows handle open inside the legacy dir: the converge keeps the sprint where it is.
    const realRename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(from) === legacyDir) throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' });
      return realRename(from, to);
    });
    const launcherDir = AbsolutePath.parse(await ensureCanonicalSprintDir(dataRoot, sprint.id, sprint.slug));
    if (!launcherDir.ok) throw launcherDir.error;
    const launcherLock = repoLockFile(storage.value.locksRoot, launcherDir.value);
    if (!launcherLock.ok) throw launcherLock.error;

    const locked: string[] = [];
    const fileLocker: FileLocker = {
      withLock: async <T>(path: AbsolutePath, fn: (signal: AbortSignal) => Promise<T>) => {
        locked.push(String(path));
        return Result.ok(await fn(new AbortController().signal)) as Result<T, StorageError>;
      },
    };
    await unblockTaskLocked(
      {
        fileLocker,
        storage: storage.value,
        taskRepo: createFsTaskRepository({ root: dataRoot }),
        sprintRepo: createFsSprintRepository({ root: dataRoot }),
        clock: IsoTimestamp.now,
        logger: noopLogger,
      },
      { sprint, taskId: task.id }
    );

    expect(locked).toEqual([String(launcherLock.value)]);
  });
});
