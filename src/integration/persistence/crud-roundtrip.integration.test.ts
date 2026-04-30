/**
 * CRUD round-trip integration test — proves every CRUD use case actually
 * persists to disk via real `FileSprintRepository` / `FileTaskRepository`.
 *
 * No fakes. The test uses a unique temp `RALPHCTL_ROOT` and exercises
 * create / edit / remove for sprint, ticket, and task by reading the
 * disk state back through a fresh repository instance after each
 * mutation. This catches the "use case returns success but doesn't
 * persist" class of bug — exactly the gap the new use cases fill.
 */
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AddTicketUseCase } from '../../business/usecases/ticket/add-ticket.ts';
import { EditTicketUseCase } from '../../business/usecases/ticket/edit-ticket.ts';
import { AddTaskUseCase } from '../../business/usecases/task/add-task.ts';
import { EditTaskUseCase } from '../../business/usecases/task/edit-task.ts';
import { CreateSprintUseCase } from '../../business/usecases/sprint/create-sprint.ts';
import { EditSprintUseCase } from '../../business/usecases/sprint/edit-sprint.ts';
import { RemoveSprintUseCase } from '../../business/usecases/sprint/remove-sprint.ts';
import { AbsolutePath } from '../../domain/values/absolute-path.ts';
import { IsoTimestamp } from '../../domain/values/iso-timestamp.ts';
import { ProjectName } from '../../domain/values/project-name.ts';
import { Slug } from '../../domain/values/slug.ts';
import type { SprintId } from '../../domain/values/sprint-id.ts';
import { FileLocker } from './file-locker.ts';
import { FileSprintRepository } from './file-sprint-repository.ts';
import { FileTaskRepository } from './file-task-repository.ts';
import { ensureLayoutDirs, resolveStoragePaths, type StoragePaths } from './storage-paths.ts';

function uniqueRoot(): AbsolutePath {
  return AbsolutePath.trustString(
    join(tmpdir(), `ralphctl-crud-${String(process.pid)}-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`)
  );
}

function slug(s: string): Slug {
  const r = Slug.parse(s);
  if (!r.ok) throw r.error;
  return r.value;
}

function projectName(name = 'demo'): ProjectName {
  const r = ProjectName.parse(name);
  if (!r.ok) throw r.error;
  return r.value;
}

function path(p: string): AbsolutePath {
  return AbsolutePath.trustString(p);
}

describe('CRUD round-trip via real file-backed repositories', () => {
  let root: AbsolutePath;
  let paths: StoragePaths;
  let sprintRepo: FileSprintRepository;
  let taskRepo: FileTaskRepository;

  beforeEach(async () => {
    root = uniqueRoot();
    paths = resolveStoragePaths({ root });
    await ensureLayoutDirs(paths);
    const locker = new FileLocker();
    sprintRepo = new FileSprintRepository(paths, locker);
    taskRepo = new FileTaskRepository(paths, locker);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('round-trips: create sprint → edit sprint → add ticket → edit ticket → add task → edit task → remove sprint', async () => {
    // 1. Create sprint via use case → file appears.
    const createUc = new CreateSprintUseCase(sprintRepo);
    const created = await createUc.execute({
      name: 'Original Name',
      slug: slug('demo-sprint'),
      now: IsoTimestamp.trustString('2026-04-29T00:00:00.000Z'),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const sprintId: SprintId = created.value.id;

    // Re-read via a fresh repo instance to prove disk persistence.
    {
      const fresh = new FileSprintRepository(paths, new FileLocker());
      const r = await fresh.findById(sprintId);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.name).toBe('Original Name');
    }

    // 2. Edit sprint name + branch → re-read shows updated values.
    const editSprintUc = new EditSprintUseCase(sprintRepo);
    const edited = await editSprintUc.execute({
      id: sprintId,
      name: 'Renamed Sprint',
      branch: 'feature/x',
    });
    expect(edited.ok).toBe(true);

    {
      const fresh = new FileSprintRepository(paths, new FileLocker());
      const r = await fresh.findById(sprintId);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.name).toBe('Renamed Sprint');
      expect(r.value.branch).toBe('feature/x');
    }

    // 3. Add ticket → re-read sprint.json shows ticket.
    const addTicketUc = new AddTicketUseCase(sprintRepo);
    const addTicketResult = await addTicketUc.execute({
      sprintId,
      ticketInput: {
        title: 'Original Title',
        projectName: projectName(),
      },
    });
    expect(addTicketResult.ok).toBe(true);
    if (!addTicketResult.ok) return;
    const ticketId = addTicketResult.value.tickets[0]?.id;
    expect(ticketId).toBeDefined();
    if (ticketId === undefined) return;

    {
      const fresh = new FileSprintRepository(paths, new FileLocker());
      const r = await fresh.findById(sprintId);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.tickets).toHaveLength(1);
      expect(r.value.tickets[0]?.title).toBe('Original Title');
    }

    // 4. Edit ticket title → re-read sprint.json shows updated title.
    const editTicketUc = new EditTicketUseCase(sprintRepo);
    const editTicketResult = await editTicketUc.execute({
      sprintId,
      ticketId,
      partial: { title: 'Updated Title' },
    });
    expect(editTicketResult.ok).toBe(true);

    {
      const fresh = new FileSprintRepository(paths, new FileLocker());
      const r = await fresh.findById(sprintId);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.tickets[0]?.title).toBe('Updated Title');
    }

    // 5. Add task → tasks.json appears.
    const addTaskUc = new AddTaskUseCase(taskRepo);
    const addTaskResult = await addTaskUc.execute({
      sprintId,
      taskInput: {
        name: 'Original Task',
        steps: ['s1'],
        verificationCriteria: ['vc1'],
        projectPath: path('/abs/repo'),
      },
    });
    expect(addTaskResult.ok).toBe(true);
    if (!addTaskResult.ok) return;
    const taskId = addTaskResult.value[0]?.id;
    expect(taskId).toBeDefined();
    if (taskId === undefined) return;

    {
      const fresh = new FileTaskRepository(paths, new FileLocker());
      const r = await fresh.findBySprintId(sprintId);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value).toHaveLength(1);
      expect(r.value[0]?.name).toBe('Original Task');
    }

    // 6. Edit task → re-read tasks.json shows updated values.
    const editTaskUc = new EditTaskUseCase(taskRepo);
    const editTaskResult = await editTaskUc.execute({
      sprintId,
      taskId,
      name: 'Updated Task',
      description: 'new desc',
      steps: ['s2', 's3'],
    });
    expect(editTaskResult.ok).toBe(true);

    {
      const fresh = new FileTaskRepository(paths, new FileLocker());
      const r = await fresh.findById(sprintId, taskId);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.name).toBe('Updated Task');
      expect(r.value.description).toBe('new desc');
      expect(r.value.steps).toEqual(['s2', 's3']);
    }

    // 7. Remove sprint → directory gone.
    const removeUc = new RemoveSprintUseCase(sprintRepo);
    const removeResult = await removeUc.execute({ id: sprintId });
    expect(removeResult.ok).toBe(true);

    {
      const fresh = new FileSprintRepository(paths, new FileLocker());
      const r = await fresh.findById(sprintId);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('not-found');
    }
  });
});
