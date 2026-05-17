import { describe, expect, it, vi } from 'vitest';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { FIXED_LATER, makeApprovedTicket, makeDraftSprint, makeTodoTask } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { planSprintUseCase } from '@src/business/sprint/plan-sprint.ts';

describe('planSprintUseCase', () => {
  it('transitions a draft sprint to planned and bundles the parsed tasks when no hook is provided', async () => {
    const sprint = makeDraftSprint({ tickets: [makeApprovedTicket()] });
    const tasks = [makeTodoTask({ name: 'first' })];
    const result = await planSprintUseCase({
      sprint,
      existingTasks: [],
      tasks,
      clock: () => FIXED_LATER,
      logger: noopLogger,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.sprint.status).toBe('planned');
      expect(result.value.tasks).toHaveLength(1);
      expect(result.value.accepted).toBe(true);
    }
  });

  it('forwards InvalidStateError when a draft sprint has no approved tickets', async () => {
    const sprint = makeDraftSprint({ tickets: [] });
    const result = await planSprintUseCase({
      sprint,
      existingTasks: [],
      tasks: [],
      clock: () => FIXED_LATER,
      logger: noopLogger,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(InvalidStateError);
  });

  it('leaves the sprint draft and returns existing tasks when the reviewer rejects', async () => {
    const sprint = makeDraftSprint({ tickets: [makeApprovedTicket()] });
    const existing = [makeTodoTask({ name: 'existing' })];
    const proposed = [makeTodoTask({ name: 'proposed' })];
    const review = vi.fn().mockResolvedValue({ accept: false });
    const result = await planSprintUseCase({
      sprint,
      existingTasks: existing,
      tasks: proposed,
      clock: () => FIXED_LATER,
      logger: noopLogger,
      reviewBeforeApprove: review,
    });
    expect(review).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.accepted).toBe(false);
      expect(result.value.sprint).toBe(sprint);
      expect(result.value.tasks).toBe(existing);
    }
  });

  it('transitions to planned when the reviewer approves', async () => {
    const sprint = makeDraftSprint({ tickets: [makeApprovedTicket()] });
    const proposed = [makeTodoTask({ name: 'proposed' })];
    const review = vi.fn().mockResolvedValue({ accept: true });
    const result = await planSprintUseCase({
      sprint,
      existingTasks: [],
      tasks: proposed,
      clock: () => FIXED_LATER,
      logger: noopLogger,
      reviewBeforeApprove: review,
    });
    expect(review).toHaveBeenCalledOnce();
    expect(review).toHaveBeenCalledWith(proposed, sprint);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.accepted).toBe(true);
      expect(result.value.sprint.status).toBe('planned');
      expect(result.value.tasks).toBe(proposed);
    }
  });
});
