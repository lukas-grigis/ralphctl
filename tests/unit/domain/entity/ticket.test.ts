import { describe, expect, it } from 'vitest';
import {
  approveTicketRequirements,
  createTicket,
  setTicketDescription,
  setTicketRequirements,
  setTicketTitle,
} from '@src/domain/entity/ticket.ts';
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

  it('trims externalRef and preserves a meaningful value', () => {
    const r = createTicket({ title: 'x', externalRef: '  #123  ' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.externalRef).toBe('#123');
  });

  it('drops a whitespace-only externalRef', () => {
    const r = createTicket({ title: 'x', externalRef: '   ' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.externalRef).toBeUndefined();
  });

  it('omits externalRef entirely when not supplied', () => {
    const r = createTicket({ title: 'x' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.externalRef).toBeUndefined();
  });
});

describe('setTicketTitle', () => {
  it('renames a pending ticket', () => {
    const r = setTicketTitle(makePendingTicket(), 'New label');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.title).toBe('New label');
    expect(r.value.status).toBe('pending');
  });

  it('renames an approved ticket without losing requirements', () => {
    const r = setTicketTitle(makeApprovedTicket({ requirements: 'keep me' }), 'Renamed');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.title).toBe('Renamed');
    expect(r.value.requirements).toBe('keep me');
  });

  it('rejects whitespace-only input', () => {
    const r = setTicketTitle(makePendingTicket(), '   ');
    expect(r.ok).toBe(false);
  });
});

describe('setTicketDescription', () => {
  it('sets the description on a pending ticket', () => {
    const r = setTicketDescription(makePendingTicket(), 'two\nlines');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.description).toBe('two\nlines');
  });

  it('clears the description on undefined', () => {
    const seeded = setTicketDescription(makePendingTicket(), 'first');
    if (!seeded.ok) throw new Error('seed');
    const r = setTicketDescription(seeded.value, undefined);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.description).toBeUndefined();
  });
});

describe('setTicketRequirements', () => {
  it('replaces the requirements body', () => {
    const r = setTicketRequirements(makeApprovedTicket(), 'updated');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.requirements).toBe('updated');
    expect(r.value.status).toBe('approved');
  });

  it('rejects whitespace-only input', () => {
    const r = setTicketRequirements(makeApprovedTicket(), '   ');
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
