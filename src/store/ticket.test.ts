import { describe, expect, it } from 'vitest';
import {
  allRequirementsApproved,
  formatTicketDisplay,
  getPendingRequirements,
  groupTicketsByProject,
} from './ticket.ts';
import type { Ticket } from '@src/schemas/index.ts';

function createTicket(overrides: Partial<Ticket> & { title: string; projectName: string }): Ticket {
  return {
    id: 'test-id-' + Math.random().toString(36).substring(7),
    description: undefined,
    link: undefined,
    requirementStatus: 'pending',
    requirements: undefined,
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

describe('allRequirementsApproved', () => {
  it('returns true when all tickets are approved', () => {
    const tickets = [
      createTicket({ title: 'T1', projectName: 'app', requirementStatus: 'approved' }),
      createTicket({ title: 'T2', projectName: 'app', requirementStatus: 'approved' }),
    ];
    expect(allRequirementsApproved(tickets)).toBe(true);
  });

  it('returns false when some tickets are pending', () => {
    const tickets = [
      createTicket({ title: 'T1', projectName: 'app', requirementStatus: 'approved' }),
      createTicket({ title: 'T2', projectName: 'app', requirementStatus: 'pending' }),
    ];
    expect(allRequirementsApproved(tickets)).toBe(false);
  });

  it('returns false for empty tickets', () => {
    expect(allRequirementsApproved([])).toBe(false);
  });

  it('returns false when all tickets are pending', () => {
    const tickets = [createTicket({ title: 'T1', projectName: 'app', requirementStatus: 'pending' })];
    expect(allRequirementsApproved(tickets)).toBe(false);
  });
});

describe('getPendingRequirements', () => {
  it('returns only pending tickets', () => {
    const tickets = [
      createTicket({ title: 'Approved', projectName: 'app', requirementStatus: 'approved' }),
      createTicket({ title: 'Pending1', projectName: 'app', requirementStatus: 'pending' }),
      createTicket({ title: 'Pending2', projectName: 'app', requirementStatus: 'pending' }),
    ];

    const pending = getPendingRequirements(tickets);

    expect(pending.length).toBe(2);
    expect(pending.map((t) => t.title)).toEqual(['Pending1', 'Pending2']);
  });

  it('returns empty array when all approved', () => {
    const tickets = [createTicket({ title: 'T1', projectName: 'app', requirementStatus: 'approved' })];
    expect(getPendingRequirements(tickets)).toEqual([]);
  });

  it('returns empty array for empty input', () => {
    expect(getPendingRequirements([])).toEqual([]);
  });
});

describe('formatTicketDisplay', () => {
  it('formats ticket with internal id and title', () => {
    const ticket = createTicket({ id: 'abc12345', title: 'Fix bug', projectName: 'app' });
    expect(formatTicketDisplay(ticket)).toBe('[abc12345] Fix bug');
  });
});
