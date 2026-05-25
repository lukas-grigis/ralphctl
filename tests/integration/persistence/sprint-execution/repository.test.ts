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

  it('upgrades a legacy execution.json whose `setupRanAt` rows omit the structured fields', async () => {
    // The pre-v0.7.0 shape stored just `{ repositoryId, ranAt }` per setup row. The codec
    // must fill in neutral defaults (`outcome: 'success'`, empty command + tails) so the
    // file loads without operator intervention. New writes emit the full structured shape;
    // this is a one-way migration that self-heals on next save.
    const repo = createFsSprintExecutionRepository({ root });
    const sprintId = SprintId.generate();
    const legacyPath = executionFile(root, sprintId);
    await mkdir(dirname(legacyPath), { recursive: true });
    const legacyRepoId = '01900000-0000-7000-8000-00000000abcd';
    const legacyRanAt = '2025-12-01T08:00:00.000Z';
    await writeFile(
      legacyPath,
      JSON.stringify({
        id: String(sprintId),
        sprintId: String(sprintId),
        branch: null,
        pullRequestUrl: null,
        setupRanAt: [{ repositoryId: legacyRepoId, ranAt: legacyRanAt }],
      }),
      'utf8'
    );

    const loaded = await repo.findById(sprintId);
    if (!loaded.ok) throw new Error(`expected ok, got ${loaded.error.message}`);
    expect(loaded.value.setupRanAt).toHaveLength(1);
    const row = loaded.value.setupRanAt[0];
    expect(String(row?.repositoryId)).toBe(legacyRepoId);
    expect(String(row?.ranAt)).toBe(legacyRanAt);
    expect(row?.outcome).toBe('success');
    expect(row?.command).toBe('');
    expect(row?.exitCode).toBe(0);
    expect(row?.durationMs).toBe(0);
    // Tail-bytes fields removed in Wave 8 / audit-[06]; the migration drops them silently.
    expect((row as Record<string, unknown> | undefined)?.['stdoutTailBytes']).toBeUndefined();
    expect((row as Record<string, unknown> | undefined)?.['stderrTailBytes']).toBeUndefined();
  });

  it('decodes an execution.json that omits baselineBrokenPolicy (field is optional — no migration needed)', async () => {
    // The pre-task-verify operator-gate feature added `baselineBrokenPolicy?: 'proceed'` as
    // an optional field. Files written before the feature simply lack the key; the schema
    // accepts the absence as `undefined` and no schemaVersion bump is required.
    const repo = createFsSprintExecutionRepository({ root });
    const sprintId = SprintId.generate();
    const legacyPath = executionFile(root, sprintId);
    await mkdir(dirname(legacyPath), { recursive: true });
    await writeFile(
      legacyPath,
      JSON.stringify({
        schemaVersion: 1,
        id: String(sprintId),
        sprintId: String(sprintId),
        branch: 'feat/x',
        pullRequestUrl: null,
        setupRanAt: [],
      }),
      'utf8'
    );

    const loaded = await repo.findById(sprintId);
    if (!loaded.ok) throw new Error(`expected ok, got ${loaded.error.message}`);
    expect(loaded.value.baselineBrokenPolicy).toBeUndefined();
    // Re-saving a loaded execution with the field still undefined must round-trip cleanly.
    const resaved = await repo.save(loaded.value);
    expect(resaved.ok).toBe(true);
    const reloaded = await repo.findById(sprintId);
    if (!reloaded.ok) throw new Error('expected ok on reload');
    expect(reloaded.value.baselineBrokenPolicy).toBeUndefined();
  });

  it('round-trips an execution with baselineBrokenPolicy = "proceed"', async () => {
    const repo = createFsSprintExecutionRepository({ root });
    const { execution } = makeDraftSprintBundle();
    const withPolicy = { ...execution, baselineBrokenPolicy: 'proceed' as const };
    const saved = await repo.save(withPolicy);
    expect(saved.ok).toBe(true);
    const loaded = await repo.findById(execution.sprintId);
    if (!loaded.ok) throw new Error('expected ok');
    expect(loaded.value.baselineBrokenPolicy).toBe('proceed');
  });
});
