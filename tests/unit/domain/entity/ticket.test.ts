import { describe, expect, it } from 'vitest';
import {
  approveTicketRequirements,
  createTicket,
  setTicketDescription,
  setTicketLink,
  setTicketRequirements,
  setTicketTitle,
} from '@src/domain/entity/ticket.ts';
import { makeApprovedTicket, makePendingTicket } from '@tests/fixtures/domain.ts';

describe('createTicket', () => {
  it('starts pending with no requirements', () => {
    const r = createTicket({ title: 'a ticket' });
    const value = r.getOrThrow();
    expect(value.status).toBe('pending');
    expect(value.requirements).toBeUndefined();
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
    const rValue = r.getOrThrow();
    expect(rValue.externalRef).toBe('#123');
  });

  it('drops a whitespace-only externalRef', () => {
    const r = createTicket({ title: 'x', externalRef: '   ' });
    const rValue = r.getOrThrow();
    expect(rValue.externalRef).toBeUndefined();
  });

  it('omits externalRef entirely when not supplied', () => {
    const r = createTicket({ title: 'x' });
    const rValue = r.getOrThrow();
    expect(rValue.externalRef).toBeUndefined();
  });

  it('derives externalRef from a GitHub issue URL when none is supplied', () => {
    const r = createTicket({ title: 'x', link: 'https://github.com/foo/bar/issues/42' });
    const rValue = r.getOrThrow();
    expect(rValue.externalRef).toBe('#42');
  });

  it('derives externalRef from a GitLab issue URL when none is supplied', () => {
    const r = createTicket({ title: 'x', link: 'https://gitlab.com/grp/sub/proj/-/issues/7' });
    const rValue = r.getOrThrow();
    expect(rValue.externalRef).toBe('#7');
  });

  it('keeps an explicitly supplied externalRef over the URL-derived one', () => {
    const r = createTicket({
      title: 'x',
      link: 'https://github.com/foo/bar/issues/42',
      externalRef: 'PROJ-7',
    });
    const rValue = r.getOrThrow();
    expect(rValue.externalRef).toBe('PROJ-7');
  });

  it('does not derive externalRef from a non-issue URL (e.g. pull request)', () => {
    const r = createTicket({ title: 'x', link: 'https://github.com/foo/bar/pull/42' });
    const rValue = r.getOrThrow();
    expect(rValue.externalRef).toBeUndefined();
  });
});

describe('setTicketLink', () => {
  it('backfills externalRef when attaching a recognised issue URL to a ticket that had none', () => {
    const r = setTicketLink(makePendingTicket(), 'https://github.com/foo/bar/issues/42');
    const rValue = r.getOrThrow();
    expect(rValue.link).toBe('https://github.com/foo/bar/issues/42');
    expect(rValue.externalRef).toBe('#42');
  });

  it('preserves an existing externalRef when the link changes', () => {
    const seeded = makePendingTicket({ externalRef: 'PROJ-7' });
    const r = setTicketLink(seeded, 'https://github.com/foo/bar/issues/99');
    const rValue = r.getOrThrow();
    expect(rValue.externalRef).toBe('PROJ-7');
  });

  it('clearing the link leaves externalRef untouched', () => {
    const seeded = makePendingTicket({ externalRef: '#42' });
    const r = setTicketLink(seeded, undefined);
    const value = r.getOrThrow();
    expect(value.link).toBeUndefined();
    expect(value.externalRef).toBe('#42');
  });
});

describe('setTicketTitle', () => {
  it('renames a pending ticket', () => {
    const r = setTicketTitle(makePendingTicket(), 'New label');
    const rValue = r.getOrThrow();
    expect(rValue.title).toBe('New label');
    expect(rValue.status).toBe('pending');
  });

  it('renames an approved ticket without losing requirements', () => {
    const r = setTicketTitle(makeApprovedTicket({ requirements: 'keep me' }), 'Renamed');
    const rValue = r.getOrThrow();
    expect(rValue.title).toBe('Renamed');
    expect(rValue.requirements).toBe('keep me');
  });

  it('rejects whitespace-only input', () => {
    const r = setTicketTitle(makePendingTicket(), '   ');
    expect(r.ok).toBe(false);
  });
});

describe('setTicketDescription', () => {
  it('sets the description on a pending ticket', () => {
    const r = setTicketDescription(makePendingTicket(), 'two\nlines');
    const rValue = r.getOrThrow();
    expect(rValue.description).toBe('two\nlines');
  });

  it('clears the description on undefined', () => {
    const seeded = setTicketDescription(makePendingTicket(), 'first');
    if (!seeded.ok) throw new Error('seed');
    const r = setTicketDescription(seeded.value, undefined);
    const rValue = r.getOrThrow();
    expect(rValue.description).toBeUndefined();
  });
});

describe('setTicketRequirements', () => {
  it('replaces the requirements body', () => {
    const r = setTicketRequirements(makeApprovedTicket(), 'updated');
    const rValue = r.getOrThrow();
    expect(rValue.requirements).toBe('updated');
    expect(rValue.status).toBe('approved');
  });

  it('rejects whitespace-only input', () => {
    const r = setTicketRequirements(makeApprovedTicket(), '   ');
    expect(r.ok).toBe(false);
  });
});

describe('approveTicketRequirements', () => {
  it('pending → approved with text', () => {
    const r = approveTicketRequirements(makePendingTicket(), 'do this well');
    const rValue = r.getOrThrow();
    expect(rValue.status).toBe('approved');
    expect(rValue.requirements).toBe('do this well');
  });

  it('rejects already-approved', () => {
    const r = approveTicketRequirements(makeApprovedTicket(), 'again');
    expect(r.ok).toBe(false);
  });
});
