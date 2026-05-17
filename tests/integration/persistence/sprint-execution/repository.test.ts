import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import { makeDraftSprintBundle } from '@tests/fixtures/domain.ts';
import { createFsSprintExecutionRepository } from '@src/integration/persistence/sprint-execution/repository.ts';
import { executionFile } from '@src/integration/persistence/storage.ts';
import { makeTmpRoot } from '@tests/fixtures/tmp-root.ts';

describe('createFsSprintExecutionRepository', () => {
  let root: AbsolutePath;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const tmp = await makeTmpRoot();
    root = tmp.root;
    cleanup = tmp.cleanup;
  });

  afterEach(async () => cleanup());

  it('round-trips an execution through save → findById', async () => {
    const repo = createFsSprintExecutionRepository({ root });
    const { execution } = makeDraftSprintBundle();

    const saved = await repo.save(execution);
    expect(saved.ok).toBe(true);

    const loaded = await repo.findById(execution.sprintId);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.value).toEqual(execution);
  });

  it('returns NotFoundError for an unknown sprint id', async () => {
    const repo = createFsSprintExecutionRepository({ root });
    const loaded = await repo.findById(SprintId.generate());
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error).toBeInstanceOf(NotFoundError);
  });

  it('save overwrites the execution (upsert)', async () => {
    const repo = createFsSprintExecutionRepository({ root });
    const { execution } = makeDraftSprintBundle();
    await repo.save(execution);
    const updated = { ...execution, branch: 'feat/new' };
    await repo.save(updated);

    const loaded = await repo.findById(execution.sprintId);
    if (!loaded.ok) throw new Error('expected ok');
    expect(loaded.value.branch).toBe('feat/new');
  });

  it('remove deletes the execution file; findById then NotFound', async () => {
    const repo = createFsSprintExecutionRepository({ root });
    const { execution } = makeDraftSprintBundle();
    await repo.save(execution);

    const removed = await repo.remove(execution.sprintId);
    expect(removed.ok).toBe(true);
    const loaded = await repo.findById(execution.sprintId);
    expect(loaded.ok).toBe(false);
  });

  it('remove of an unknown id returns NotFoundError', async () => {
    const repo = createFsSprintExecutionRepository({ root });
    const removed = await repo.remove(SprintId.generate());
    expect(removed.ok).toBe(false);
    if (!removed.ok) expect(removed.error).toBeInstanceOf(NotFoundError);
  });

  it('decodes a legacy execution.json that omits `id` (fills from `sprintId`)', async () => {
    const repo = createFsSprintExecutionRepository({ root });
    const sprintId = SprintId.generate();
    const legacyPath = executionFile(root, sprintId);
    await mkdir(dirname(legacyPath), { recursive: true });
    await writeFile(
      legacyPath,
      JSON.stringify({
        sprintId: String(sprintId),
        branch: null,
        pullRequestUrl: null,
        setupRanAt: [],
      }),
      'utf8'
    );

    const loaded = await repo.findById(sprintId);
    if (!loaded.ok) throw new Error(`expected ok, got ${loaded.error.message}`);
    expect(String(loaded.value.id)).toBe(String(sprintId));
    expect(String(loaded.value.sprintId)).toBe(String(sprintId));
  });
});
