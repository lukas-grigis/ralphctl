import { describe, expect, it } from 'vitest';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { makeActiveSprint, makeDraftSprint, makePendingTicket } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { addApprovedTicketUseCase } from '@src/business/ticket/add-approved-ticket.ts';

describe('addApprovedTicketUseCase', () => {
  it('approves and adds a ticket to a draft sprint', () => {
    const sprint = makeDraftSprint({ tickets: [] });
    const ticket = makePendingTicket({ title: 'idea' });
    const result = addApprovedTicketUseCase({
      sprint,
      ticket,
      requirementsBody: '## Acceptance\n- works',
      logger: noopLogger,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.sprint.tickets).toHaveLength(1);
      expect(result.value.ticket.status).toBe('approved');
    }
  });

  it('rejects when sprint is not draft', () => {
    const sprint = makeActiveSprint();
    const ticket = makePendingTicket({ title: 'too-late' });
    const result = addApprovedTicketUseCase({
      sprint,
      ticket,
      requirementsBody: 'something',
      logger: noopLogger,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(InvalidStateError);
  });

  it('rejects an empty requirements body', () => {
    const sprint = makeDraftSprint({ tickets: [] });
    const ticket = makePendingTicket();
    const result = addApprovedTicketUseCase({
      sprint,
      ticket,
      requirementsBody: '   ',
      logger: noopLogger,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(InvalidStateError);
  });
});
