import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import { addTicket } from '@src/domain/entity/sprint.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { Save } from '@src/domain/repository/_base/save.ts';
import { makeActiveSprint, makeDraftSprint, makePendingTicket } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { removeTicketUseCase } from '@src/business/ticket/remove-ticket.ts';

const okSave: Save<Sprint> = {
  async save() {
    return Result.ok(undefined);
  },
};

describe('removeTicketUseCase', () => {
  it('removes a ticket from a draft sprint and persists', async () => {
    const ticket = makePendingTicket();
    const seeded = addTicket(makeDraftSprint({ tickets: [] }), ticket);
    if (!seeded.ok) throw new Error(`fixture: ${seeded.error.message}`);
    const result = await removeTicketUseCase({
      sprint: seeded.value,
      ticketId: ticket.id,
      sprintRepo: okSave,
      logger: noopLogger,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.tickets).toHaveLength(0);
  });

  it('rejects on non-draft sprints', async () => {
    const sprint = makeActiveSprint();
    const result = await removeTicketUseCase({
      sprint,
      ticketId: sprint.tickets[0]!.id,
      sprintRepo: okSave,
      logger: noopLogger,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(InvalidStateError);
  });
});
