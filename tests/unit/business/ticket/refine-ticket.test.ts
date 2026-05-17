import { describe, expect, it, vi } from 'vitest';
import { addTicket } from '@src/domain/entity/sprint.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { makeDraftSprint, makePendingTicket } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { refineTicketUseCase } from '@src/business/ticket/refine-ticket.ts';

describe('refineTicketUseCase', () => {
  const seedSprintWithTicket = () => {
    const ticket = makePendingTicket({ title: 'design schema' });
    const seeded = addTicket(makeDraftSprint({ tickets: [] }), ticket);
    if (!seeded.ok) throw new Error(`fixture: ${seeded.error.message}`);
    return { sprint: seeded.value, ticket };
  };

  it('approves the ticket and replaces it on the sprint when no reviewer is wired', async () => {
    const { sprint, ticket } = seedSprintWithTicket();
    const result = await refineTicketUseCase({
      sprint,
      ticket,
      requirementsBody: '## Acceptance\n- column foo exists',
      logger: noopLogger,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.accepted).toBe(true);
      expect(result.value.ticket.status).toBe('approved');
      expect(result.value.sprint.tickets[0]?.status).toBe('approved');
    }
  });

  it('rejects an empty requirements body with InvalidStateError', async () => {
    const { sprint, ticket } = seedSprintWithTicket();
    const result = await refineTicketUseCase({
      sprint,
      ticket,
      requirementsBody: '   ',
      logger: noopLogger,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(InvalidStateError);
  });

  it('skips the entity transition when reviewBeforeApprove returns accept: false', async () => {
    const { sprint, ticket } = seedSprintWithTicket();
    const review = vi.fn(async () => ({ accept: false }));
    const result = await refineTicketUseCase({
      sprint,
      ticket,
      requirementsBody: '## Acceptance\n- column foo exists',
      logger: noopLogger,
      reviewBeforeApprove: review,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Sprint unchanged, ticket still pending, reviewer was consulted exactly once.
    expect(result.value.accepted).toBe(false);
    expect(result.value.ticket).toBe(ticket);
    expect(result.value.sprint).toBe(sprint);
    expect(result.value.ticket.status).toBe('pending');
    expect(review).toHaveBeenCalledTimes(1);
    expect(review).toHaveBeenCalledWith('## Acceptance\n- column foo exists', ticket);
  });

  it('passes the proposed body and ticket through to reviewBeforeApprove and approves on accept: true', async () => {
    const { sprint, ticket } = seedSprintWithTicket();
    let seenProposed: string | undefined;
    const review = vi.fn(async (proposed: string) => {
      seenProposed = proposed;
      return { accept: true };
    });
    const result = await refineTicketUseCase({
      sprint,
      ticket,
      requirementsBody: '## Acceptance\n- column foo exists',
      logger: noopLogger,
      reviewBeforeApprove: review,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.accepted).toBe(true);
    expect(result.value.alsoUpdateOrigin).toBe(false);
    expect(result.value.ticket.status).toBe('approved');
    expect(seenProposed).toBe('## Acceptance\n- column foo exists');
  });

  it('forwards alsoUpdateOrigin from the reviewer when approved', async () => {
    const { sprint, ticket } = seedSprintWithTicket();
    const review = vi.fn(async () => ({ accept: true, alsoUpdateOrigin: true }));
    const result = await refineTicketUseCase({
      sprint,
      ticket,
      requirementsBody: '## Acceptance\n- column foo exists',
      logger: noopLogger,
      reviewBeforeApprove: review,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.accepted).toBe(true);
    expect(result.value.alsoUpdateOrigin).toBe(true);
    expect(result.value.ticket.status).toBe('approved');
  });

  it('on reject the output carries alsoUpdateOrigin: false even when the reviewer requested origin', async () => {
    const { sprint, ticket } = seedSprintWithTicket();
    const review = vi.fn(async () => ({ accept: false, alsoUpdateOrigin: true }));
    const result = await refineTicketUseCase({
      sprint,
      ticket,
      requirementsBody: '## Acceptance\n- column foo exists',
      logger: noopLogger,
      reviewBeforeApprove: review,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.accepted).toBe(false);
    expect(result.value.alsoUpdateOrigin).toBe(false);
  });
});
