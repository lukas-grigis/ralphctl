import { describe, expect, it } from 'vitest';
import { approveTicketRequirements, createTicket } from '@src/domain/entity/ticket.ts';
import { makeApprovedTicket, makePendingTicket } from '@tests/fixtures/domain.ts';

describe('createTicket', () => {
  it('starts pending with no requirements', () => {
    const r = createTicket({ title: 'a ticket' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.status).toBe('pending');
    expect(r.value.requirements).toBeUndefined();
  });

  it('rejects empty title', () => {
    const r = createTicket({ title: '   ' });
    expect(r.ok).toBe(false);
  });

  it('rejects bad link', () => {
    const r = createTicket({ title: 'x', link: 'ftp://nope' });
    expect(r.ok).toBe(false);
  });
});

describe('approveTicketRequirements', () => {
  it('pending → approved with text', () => {
    const r = approveTicketRequirements(makePendingTicket(), 'do this well');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.status).toBe('approved');
    expect(r.value.requirements).toBe('do this well');
  });

  it('rejects already-approved', () => {
    const r = approveTicketRequirements(makeApprovedTicket(), 'again');
    expect(r.ok).toBe(false);
  });
});
