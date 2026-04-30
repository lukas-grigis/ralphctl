// Ported from afe771f9~1:src/store/task.test.ts — import edge cases and round-trip coverage
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Task } from '../../domain/entities/task.ts';
import { AbsolutePath } from '../../domain/values/absolute-path.ts';
import { Slug } from '../../domain/values/slug.ts';
import { SprintId } from '../../domain/values/sprint-id.ts';
import { TaskId } from '../../domain/values/task-id.ts';
import { FileLocker } from './file-locker.ts';
import { FileTaskRepository } from './file-task-repository.ts';
import { ensureLayoutDirs, resolveStoragePaths, type StoragePaths } from './storage-paths.ts';

function uniqueRoot(): AbsolutePath {
  return AbsolutePath.trustString(
    join(tmpdir(), `ralphctl-tsk-${String(process.pid)}-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`)
  );
}

function makeSprintId(): SprintId {
  const slug = Slug.parse('demo');
  if (!slug.ok) throw slug.error;
  return SprintId.create(new Date('2026-04-29T00:00:00.000Z'), slug.value);
}

function makeTask(name: string, order: number): Task {
  const r = Task.create({
    name,
    steps: [`step-for-${name}`],
    verificationCriteria: ['done'],
    order,
    blockedBy: [],
    projectPath: AbsolutePath.trustString('/code'),
  });
  if (!r.ok) throw r.error;
  return r.value;
}

describe('FileTaskRepository', () => {
  let root: AbsolutePath;
  let paths: StoragePaths;
  let repo: FileTaskRepository;
  let sprintId: SprintId;

  beforeEach(async () => {
    root = uniqueRoot();
    paths = resolveStoragePaths({ root });
    await ensureLayoutDirs(paths);
    repo = new FileTaskRepository(paths, new FileLocker());
    sprintId = makeSprintId();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('findBySprintId returns [] when no tasks file exists yet', async () => {
    const r = await repo.findBySprintId(sprintId);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([]);
  });

  it('saveAll then findBySprintId round-trip the task list', async () => {
    const t1 = makeTask('a', 1);
    const t2 = makeTask('b', 2);
    const w = await repo.saveAll(sprintId, [t1, t2]);
    expect(w.ok).toBe(true);
    const r = await repo.findBySprintId(sprintId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toHaveLength(2);
    expect(r.value.map((t) => t.id).sort()).toEqual([t1.id, t2.id].sort());
  });

  it('saveAll replaces the entire task list atomically', async () => {
    await repo.saveAll(sprintId, [makeTask('first', 1), makeTask('second', 2)]);
    const replacement = makeTask('only', 1);
    await repo.saveAll(sprintId, [replacement]);
    const r = await repo.findBySprintId(sprintId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toHaveLength(1);
    expect(r.value[0]?.id).toBe(replacement.id);
  });

  it('findById returns the matching task', async () => {
    const t = makeTask('findable', 1);
    await repo.saveAll(sprintId, [t]);
    const r = await repo.findById(sprintId, t.id);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.name).toBe('findable');
  });

  it('findById returns NotFoundError for a missing task id', async () => {
    await repo.saveAll(sprintId, [makeTask('present', 1)]);
    const ghost = TaskId.trustString('ffffffff');
    const r = await repo.findById(sprintId, ghost);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('not-found');
  });

  it('update modifies a single task in place', async () => {
    const t = makeTask('todo', 1);
    await repo.saveAll(sprintId, [t]);
    const moving = t.markInProgress();
    if (!moving.ok) throw moving.error;
    const u = await repo.update(sprintId, moving.value);
    expect(u.ok).toBe(true);
    const r = await repo.findById(sprintId, t.id);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.status).toBe('in_progress');
  });

  it('update returns NotFoundError when no tasks file exists yet', async () => {
    const t = makeTask('lonely', 1);
    const r = await repo.update(sprintId, t);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('not-found');
  });

  it('update returns NotFoundError when the task id is not in the list', async () => {
    await repo.saveAll(sprintId, [makeTask('only', 1)]);
    const stranger = makeTask('stranger', 2);
    const r = await repo.update(sprintId, stranger);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('not-found');
  });

  it('preserves order across multiple updates', async () => {
    const t1 = makeTask('one', 1);
    const t2 = makeTask('two', 2);
    await repo.saveAll(sprintId, [t1, t2]);
    const moving = t1.markInProgress();
    if (!moving.ok) throw moving.error;
    await repo.update(sprintId, moving.value);
    const r = await repo.findBySprintId(sprintId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.map((t) => t.id)).toEqual([t1.id, t2.id]);
    expect(r.value[0]?.status).toBe('in_progress');
    expect(r.value[1]?.status).toBe('todo');
  });

  it('serialises concurrent updates within the same sprint', async () => {
    const t1 = makeTask('one', 1);
    const t2 = makeTask('two', 2);
    await repo.saveAll(sprintId, [t1, t2]);
    const m1 = t1.markInProgress();
    const m2 = t2.markInProgress();
    if (!m1.ok || !m2.ok) throw new Error('setup');
    const [r1, r2] = await Promise.all([repo.update(sprintId, m1.value), repo.update(sprintId, m2.value)]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    const list = await repo.findBySprintId(sprintId);
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    // Both updates must land — neither should be lost to a read-modify-write
    // race; that's exactly the file lock's job.
    expect(list.value.every((t) => t.status === 'in_progress')).toBe(true);
  });

  it('round-trips a task with all optional fields populated', async () => {
    // verificationCriteria, evaluationOutput, evaluationStatus, extraDimensions,
    // description, verificationOutput, and evaluationFile must all survive
    // a saveAll → findById round-trip without loss.
    const slug = Slug.parse('ticket-1');
    if (!slug.ok) throw slug.error;
    const r = Task.create({
      name: 'full-optional',
      description: 'a detailed description',
      steps: ['step-a', 'step-b'],
      verificationCriteria: ['check-1', 'check-2'],
      order: 1,
      blockedBy: [],
      projectPath: AbsolutePath.trustString('/code'),
      extraDimensions: ['Performance', 'Maintainability'],
    });
    if (!r.ok) throw r.error;
    let task = r.value;

    // Record verification output.
    task = task.recordVerification('all tests pass, coverage 95%');

    // Progress to in_progress then done so we can call markDone.
    const inProgress = task.markInProgress();
    if (!inProgress.ok) throw inProgress.error;
    const done = inProgress.value.markDone();
    if (!done.ok) throw done.error;

    // Record evaluation output on the done task.
    task = done.value.recordEvaluation({
      output: 'implementation looks correct',
      status: 'passed',
      file: '/tmp/evaluations/task.md',
    });

    await repo.saveAll(sprintId, [task]);
    const found = await repo.findById(sprintId, task.id);
    expect(found.ok).toBe(true);
    if (!found.ok) return;

    const loaded = found.value;
    expect(loaded.description).toBe('a detailed description');
    expect(loaded.verificationCriteria).toEqual(['check-1', 'check-2']);
    expect(loaded.extraDimensions).toEqual(['Performance', 'Maintainability']);
    expect(loaded.verified).toBe(true);
    expect(loaded.verificationOutput).toBe('all tests pass, coverage 95%');
    expect(loaded.evaluated).toBe(true);
    expect(loaded.evaluationOutput).toBe('implementation looks correct');
    expect(loaded.evaluationStatus).toBe('passed');
    expect(loaded.evaluationFile).toBe('/tmp/evaluations/task.md');
  });

  it('update leaves sibling tasks unchanged', async () => {
    const t1 = makeTask('sibling-a', 1);
    const t2 = makeTask('sibling-b', 2);
    const t3 = makeTask('sibling-c', 3);
    await repo.saveAll(sprintId, [t1, t2, t3]);

    const moving = t2.markInProgress();
    if (!moving.ok) throw moving.error;
    const u = await repo.update(sprintId, moving.value);
    expect(u.ok).toBe(true);

    const list = await repo.findBySprintId(sprintId);
    expect(list.ok).toBe(true);
    if (!list.ok) return;

    const byId = new Map(list.value.map((t) => [t.id, t]));
    expect(byId.get(t1.id)?.status).toBe('todo');
    expect(byId.get(t2.id)?.status).toBe('in_progress');
    expect(byId.get(t3.id)?.status).toBe('todo');
  });
});
