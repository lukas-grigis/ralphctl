import { describe, expect, it } from 'vitest';

import { TicketId } from '@src/domain/values/ticket-id.ts';
import { Ticket } from './ticket.ts';

describe('Ticket.create', () => {
  it('builds a pending ticket with a generated id when none is supplied', () => {
    const r = Ticket.create({ title: 'Add OAuth login' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.title).toBe('Add OAuth login');
    expect(r.value.requirementStatus).toBe('pending');
    expect(r.value.id).toMatch(/^[0-9a-f]{8}$/);
    expect(r.value.requirements).toBeUndefined();
  });

  it('uses the supplied id when provided', () => {
    const idR = TicketId.parse('deadbeef');
    if (!idR.ok) throw new Error('precondition failed');
    const r = Ticket.create({ id: idR.value, title: 'X' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.id).toBe('deadbeef');
  });

  it('trims the title and rejects empty-after-trim', () => {
    const ok = Ticket.create({ title: '   foo   ' });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.title).toBe('foo');

    const bad = Ticket.create({ title: '   ' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.field).toBe('ticket.title');
  });

  it('accepts a valid URL as link', () => {
    const r = Ticket.create({
      title: 't',
      link: 'https://github.com/foo/bar/issues/1',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.link).toBe('https://github.com/foo/bar/issues/1');
  });

  it('rejects a malformed link', () => {
    const r = Ticket.create({ title: 't', link: 'not a url' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe('ticket.link');
  });

  it('omits empty description after trim', () => {
    const r = Ticket.create({ title: 't', description: '   ' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.description).toBeUndefined();
  });
});

describe('Ticket.approveRequirements', () => {
  it('moves pending → approved and stores the text', () => {
    const t0 = Ticket.create({ title: 't' });
    if (!t0.ok) throw new Error('precondition failed');
    const t1 = t0.value.approveRequirements('REQUIREMENTS BODY');
    expect(t1.ok).toBe(true);
    if (!t1.ok) return;
    expect(t1.value.requirementStatus).toBe('approved');
    expect(t1.value.requirements).toBe('REQUIREMENTS BODY');
  });

  it('rejects re-approval', () => {
    const t0 = Ticket.create({ title: 't' });
    if (!t0.ok) throw new Error('precondition failed');
    const t1 = t0.value.approveRequirements('a');
    if (!t1.ok) throw new Error('precondition failed');
    const t2 = t1.value.approveRequirements('b');
    expect(t2.ok).toBe(false);
    if (!t2.ok) {
      expect(t2.error.code).toBe('invalid-state');
      expect(t2.error.attemptedAction).toBe('approve-requirements');
      expect(t2.error.currentState).toBe('approved');
    }
  });

  it('does not mutate the original ticket', () => {
    const t0 = Ticket.create({ title: 't' });
    if (!t0.ok) throw new Error('precondition failed');
    const original = t0.value;
    const snapshot = {
      id: original.id,
      requirementStatus: original.requirementStatus,
      requirements: original.requirements,
    };
    original.approveRequirements('xxx');
    expect(original.requirementStatus).toBe(snapshot.requirementStatus);
    expect(original.requirements).toBe(snapshot.requirements);
  });
});
