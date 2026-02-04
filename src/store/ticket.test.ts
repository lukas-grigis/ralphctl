import { describe, expect, it } from 'vitest';
import { allTicketsApproved, formatTicketDisplay, getPendingTickets, groupTicketsByProject } from './ticket.ts';
import type { Ticket } from '@src/schemas/index.ts';

function createTicket(overrides: Partial<Ticket> & { title: string; projectName: string }): Ticket {
  return {
    id: 'test-id-' + Math.random().toString(36).substring(7),
    externalId: undefined,
    description: undefined,
    link: undefined,
    specStatus: 'pending',
    specs: undefined,
    ...overrides,
  };
}

describe('groupTicketsByProject', () => {
  it('groups tickets by project name', () => {
    const tickets = [
      createTicket({ title: 'T1', projectName: 'frontend' }),
      createTicket({ title: 'T2', projectName: 'backend' }),
      createTicket({ title: 'T3', projectName: 'frontend' }),
    ];

    const grouped = groupTicketsByProject(tickets);

    expect(grouped.size).toBe(2);
    expect(grouped.get('frontend')?.length).toBe(2);
    expect(grouped.get('backend')?.length).toBe(1);
  });

  it('returns empty map for empty tickets', () => {
    const grouped = groupTicketsByProject([]);
    expect(grouped.size).toBe(0);
  });

  it('handles single project', () => {
    const tickets = [
      createTicket({ title: 'T1', projectName: 'app' }),
      createTicket({ title: 'T2', projectName: 'app' }),
    ];

    const grouped = groupTicketsByProject(tickets);

    expect(grouped.size).toBe(1);
    expect(grouped.get('app')?.length).toBe(2);
  });

  it('preserves ticket order within groups', () => {
    const tickets = [
      createTicket({ title: 'First', projectName: 'app' }),
      createTicket({ title: 'Second', projectName: 'app' }),
      createTicket({ title: 'Third', projectName: 'app' }),
    ];

    const grouped = groupTicketsByProject(tickets);
    const appTickets = grouped.get('app');

    expect(appTickets?.map((t) => t.title)).toEqual(['First', 'Second', 'Third']);
  });
});

describe('allTicketsApproved', () => {
  it('returns true when all tickets are approved', () => {
    const tickets = [
      createTicket({ title: 'T1', projectName: 'app', specStatus: 'approved' }),
      createTicket({ title: 'T2', projectName: 'app', specStatus: 'approved' }),
    ];
    expect(allTicketsApproved(tickets)).toBe(true);
  });

  it('returns false when some tickets are pending', () => {
    const tickets = [
      createTicket({ title: 'T1', projectName: 'app', specStatus: 'approved' }),
      createTicket({ title: 'T2', projectName: 'app', specStatus: 'pending' }),
    ];
    expect(allTicketsApproved(tickets)).toBe(false);
  });

  it('returns false for empty tickets', () => {
    expect(allTicketsApproved([])).toBe(false);
  });

  it('returns false when all tickets are pending', () => {
    const tickets = [createTicket({ title: 'T1', projectName: 'app', specStatus: 'pending' })];
    expect(allTicketsApproved(tickets)).toBe(false);
  });
});

describe('getPendingTickets', () => {
  it('returns only pending tickets', () => {
    const tickets = [
      createTicket({ title: 'Approved', projectName: 'app', specStatus: 'approved' }),
      createTicket({ title: 'Pending1', projectName: 'app', specStatus: 'pending' }),
      createTicket({ title: 'Pending2', projectName: 'app', specStatus: 'pending' }),
    ];

    const pending = getPendingTickets(tickets);

    expect(pending.length).toBe(2);
    expect(pending.map((t) => t.title)).toEqual(['Pending1', 'Pending2']);
  });

  it('returns empty array when all approved', () => {
    const tickets = [createTicket({ title: 'T1', projectName: 'app', specStatus: 'approved' })];
    expect(getPendingTickets(tickets)).toEqual([]);
  });

  it('returns empty array for empty input', () => {
    expect(getPendingTickets([])).toEqual([]);
  });
});

describe('formatTicketDisplay', () => {
  it('formats ticket with externalId', () => {
    const ticket = createTicket({ id: 'abc12345', externalId: 'JIRA-123', title: 'Fix bug', projectName: 'app' });
    expect(formatTicketDisplay(ticket)).toBe('[abc12345] (JIRA-123) Fix bug');
  });

  it('formats ticket without externalId using internal id only', () => {
    const ticket = createTicket({ id: 'abc12345', title: 'Fix bug', projectName: 'app' });
    expect(formatTicketDisplay(ticket)).toBe('[abc12345] Fix bug');
  });

  it('formats ticket with empty string externalId using internal id only', () => {
    const ticket = createTicket({ id: 'abc12345', externalId: '', title: 'Fix bug', projectName: 'app' });
    // Empty string is falsy, so should not show external ID part
    expect(formatTicketDisplay(ticket)).toBe('[abc12345] Fix bug');
  });
});
