import { describe, expect, it, vi } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { TaskRepository } from '@src/domain/repository/task/task-repository.ts';
import { buildTaskEdit, buildTicketEdit } from '@src/application/ui/tui/views/sprint-detail-internals/field-editors.ts';
import {
  makeApprovedTicket,
  makeDraftSprint,
  makeInProgressTaskWithRunningAttempt,
  makeTodoTask,
} from '@tests/fixtures/domain.ts';

describe('buildTicketEdit', () => {
  it('applies the edit to the sprint re-read at save time, keeping a concurrent change', async () => {
    const ticket = makeApprovedTicket({ title: 'Old title', requirements: 'v1 requirements' });
    const snapshot = makeDraftSprint({ tickets: [ticket] });
    // refine rewrote the requirements while the title prompt was open.
    const onDisk: Sprint = { ...snapshot, tickets: [{ ...ticket, requirements: 'v2 requirements' }] };
    const save = vi.fn<SprintRepository['save']>(async () => Result.ok(undefined));
    const sprintRepo = { findById: async () => Result.ok(onDisk), save };

    const cfg = buildTicketEdit({ sprint: snapshot, ticket, field: 'title', sprintRepo, reload: () => undefined });
    const result = await cfg?.onSave('New title');

    expect(result?.ok).toBe(true);
    const saved = save.mock.calls[0]?.[0];
    expect(saved?.tickets[0]).toMatchObject({ title: 'New title', requirements: 'v2 requirements' });
  });

  it('fails when the ticket no longer exists on disk', async () => {
    const ticket = makeApprovedTicket();
    const snapshot = makeDraftSprint({ tickets: [ticket] });
    const save = vi.fn<SprintRepository['save']>(async () => Result.ok(undefined));
    const sprintRepo = { findById: async () => Result.ok<Sprint>({ ...snapshot, tickets: [] }), save };

    const cfg = buildTicketEdit({ sprint: snapshot, ticket, field: 'title', sprintRepo, reload: () => undefined });
    const result = await cfg?.onSave('New title');

    expect(result?.ok).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });
});

describe('buildTaskEdit', () => {
  it('refuses to save when implement started the task while the prompt was open', async () => {
    const running = makeInProgressTaskWithRunningAttempt();
    const snapshot: Task = { ...makeTodoTask(), id: running.id };
    const update = vi.fn<TaskRepository['update']>(async () => Result.ok(undefined));
    const taskRepo = { findById: async () => Result.ok<Task>(running), update };

    const cfg = buildTaskEdit({
      sprint: makeDraftSprint(),
      task: snapshot,
      field: 'name',
      taskRepo,
      reload: () => undefined,
    });
    const result = await cfg?.onSave('renamed');

    expect(result?.ok).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it('applies the edit to the task re-read at save time', async () => {
    const snapshot = makeTodoTask({ name: 'old name' });
    const onDisk: Task = { ...snapshot, steps: ['step 1', 'step added meanwhile'] };
    const update = vi.fn<TaskRepository['update']>(async () => Result.ok(undefined));
    const taskRepo = { findById: async () => Result.ok<Task>(onDisk), update };

    const cfg = buildTaskEdit({
      sprint: makeDraftSprint(),
      task: snapshot,
      field: 'name',
      taskRepo,
      reload: () => undefined,
    });
    const result = await cfg?.onSave('new name');

    expect(result?.ok).toBe(true);
    expect(update.mock.calls[0]?.[1]).toMatchObject({ name: 'new name', steps: ['step 1', 'step added meanwhile'] });
  });
});
