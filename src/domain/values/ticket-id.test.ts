import { describe, expect, it } from 'vitest';

import { TicketId } from './ticket-id.ts';

describe('TicketId', () => {
  it('accepts 8 lowercase hex chars', () => {
    const r = TicketId.parse('deadbeef');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe('deadbeef');
  });

  it('accepts all-digit hex strings', () => {
    const r = TicketId.parse('01234567');
    expect(r.ok).toBe(true);
  });

  it('rejects uppercase hex chars', () => {
    const r = TicketId.parse('DEADBEEF');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.field).toBe('ticket-id');
      expect(r.error.value).toBe('DEADBEEF');
    }
  });

  it('rejects strings shorter than 8 chars', () => {
    const r = TicketId.parse('deadbee');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe('ticket-id');
  });

  it('rejects strings longer than 8 chars', () => {
    const r = TicketId.parse('deadbeef0');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.value).toBe('deadbeef0');
  });

  it('rejects non-hex chars', () => {
    const r = TicketId.parse('zzzzzzzz');
    expect(r.ok).toBe(false);
  });

  it('rejects non-string input', () => {
    const r = TicketId.parse(123);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.field).toBe('ticket-id');
      expect(r.error.value).toBe(123);
    }
  });

  it('generate() produces a parseable TicketId', () => {
    const id = TicketId.generate();
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    const r = TicketId.parse(id);
    expect(r.ok).toBe(true);
  });

  it('generate() returns a different value each call (with overwhelming probability)', () => {
    const a = TicketId.generate();
    const b = TicketId.generate();
    expect(a).not.toBe(b);
  });

  it('trustString returns the input typed as a TicketId', () => {
    const id: TicketId = TicketId.trustString('cafebabe');
    expect(id).toBe('cafebabe');
  });
});
