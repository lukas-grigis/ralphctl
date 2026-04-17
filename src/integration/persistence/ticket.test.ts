import { describe, expect, it } from 'vitest';
import { allRequirementsApproved, formatTicketDisplay, getPendingRequirements } from './ticket.ts';
import type { Ticket } from '@src/domain/models.ts';

function createTicket(overrides: Partial<Ticket> & { title: string }): Ticket {
  return {
    id: 'test-id-' + Math.random().toString(36).substring(7),
    description: undefined,
    link: undefined,
    requirementStatus: 'pending',
    requirements: undefined,
    ...overrides,
  };
}

describe('allRequirementsApproved', () => {
  it('returns true when all tickets are approved', () => {
    const tickets = [
      createTicket({ title: 'T1', requirementStatus: 'approved' }),
      createTicket({ title: 'T2', requirementStatus: 'approved' }),
    ];
    expect(allRequirementsApproved(tickets)).toBe(true);
  });

  it('returns false when some tickets are pending', () => {
    const tickets = [
      createTicket({ title: 'T1', requirementStatus: 'approved' }),
      createTicket({ title: 'T2', requirementStatus: 'pending' }),
    ];
    expect(allRequirementsApproved(tickets)).toBe(false);
  });

  it('returns false for empty tickets', () => {
    expect(allRequirementsApproved([])).toBe(false);
  });

  it('returns false when all tickets are pending', () => {
    const tickets = [createTicket({ title: 'T1', requirementStatus: 'pending' })];
    expect(allRequirementsApproved(tickets)).toBe(false);
  });
});

describe('getPendingRequirements', () => {
  it('returns only pending tickets', () => {
    const tickets = [
      createTicket({ title: 'Approved', requirementStatus: 'approved' }),
      createTicket({ title: 'Pending1', requirementStatus: 'pending' }),
      createTicket({ title: 'Pending2', requirementStatus: 'pending' }),
    ];

    const pending = getPendingRequirements(tickets);

    expect(pending.length).toBe(2);
    expect(pending.map((t) => t.title)).toEqual(['Pending1', 'Pending2']);
  });

  it('returns empty array when all approved', () => {
    const tickets = [createTicket({ title: 'T1', requirementStatus: 'approved' })];
    expect(getPendingRequirements(tickets)).toEqual([]);
  });

  it('returns empty array for empty input', () => {
    expect(getPendingRequirements([])).toEqual([]);
  });
});

describe('formatTicketDisplay', () => {
  it('formats ticket with internal id and title', () => {
    const ticket = createTicket({ id: 'abc12345', title: 'Fix bug' });
    expect(formatTicketDisplay(ticket)).toBe('[abc12345] Fix bug');
  });
});
