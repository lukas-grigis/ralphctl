import { describe, expect, it } from 'vitest';
import { addTicket } from '@src/domain/entity/sprint.ts';
import { ConflictError } from '@src/domain/value/error/conflict-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import { makeActiveSprint, makeDraftSprint, makePendingTicket } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { addTicketUseCase } from '@src/business/ticket/add-ticket.ts';

describe('addTicketUseCase', () => {
  it('appends a fresh pending ticket to a draft sprint', () => {
    const sprint = makeDraftSprint({ tickets: [] });

    const result = addTicketUseCase({
      sprint,
      ticket: { title: 'export the spec', description: 'json + xml', link: 'https://example.com/x' },
      logger: noopLogger,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.ticket.status).toBe('pending');
      expect(result.value.ticket.title).toBe('export the spec');
      expect(result.value.ticket.description).toBe('json + xml');
      expect(String(result.value.ticket.link)).toBe('https://example.com/x');
      expect(result.value.sprint.tickets).toHaveLength(1);
      expect(result.value.sprint.tickets[0]?.id).toBe(result.value.ticket.id);
    }
  });

  it('returns a ValidationError when the title is empty', () => {
    const sprint = makeDraftSprint({ tickets: [] });

    const result = addTicketUseCase({ sprint, ticket: { title: '   ' }, logger: noopLogger });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ValidationError);
      expect((result.error as ValidationError).field).toBe('ticket.title');
    }
  });

  it('returns a ConflictError when the same ticket id already exists on the sprint', () => {
    let sprint = makeDraftSprint({ tickets: [] });
    const existing = makePendingTicket({ title: 'first' });
    const seeded = addTicket(sprint, existing);
    if (!seeded.ok) throw new Error(`fixture: addTicket failed: ${seeded.error.message}`);
    sprint = seeded.value;

    const result = addTicketUseCase({ sprint, ticket: { id: existing.id, title: 'duplicate' }, logger: noopLogger });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ConflictError);
      expect((result.error as ConflictError).field).toBe('id');
    }
  });

  it('returns an InvalidStateError when the sprint is not draft', () => {
    const active = makeActiveSprint();

    const result = addTicketUseCase({ sprint: active, ticket: { title: 'too-late' }, logger: noopLogger });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(InvalidStateError);
      expect((result.error as InvalidStateError).attemptedAction).toBe('add-ticket');
    }
  });

  it('threads a successful result through both validation and aggregate steps', () => {
    const sprint = makeDraftSprint({ tickets: [] });

    const first = addTicketUseCase({ sprint, ticket: { title: 'one' }, logger: noopLogger });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = addTicketUseCase({ sprint: first.value.sprint, ticket: { title: 'two' }, logger: noopLogger });
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.value.sprint.tickets.map((t) => t.title)).toEqual(['one', 'two']);
    }
  });
});
