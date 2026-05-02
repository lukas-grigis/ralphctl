import { describe, expect, it } from 'vitest';

import { Slug } from './slug.ts';
import { SprintId } from './sprint-id.ts';
import { TicketId } from './ticket-id.ts';

describe('SprintId', () => {
  it('accepts a well-formed id with multi-segment slug', () => {
    const r = SprintId.parse('20260429-141522-my-sprint');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe('20260429-141522-my-sprint');
  });

  it('accepts a single-character slug suffix', () => {
    const r = SprintId.parse('20240101-000000-x');
    expect(r.ok).toBe(true);
  });

  it('rejects ISO-style date prefix', () => {
    const r = SprintId.parse('2024-04-29-foo');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.field).toBe('sprint-id');
      expect(r.error.value).toBe('2024-04-29-foo');
    }
  });

  it('rejects wrong time width', () => {
    const r = SprintId.parse('20260429-1415-my-sprint');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe('sprint-id');
  });

  it('rejects empty slug suffix', () => {
    const r = SprintId.parse('20260429-141522-');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.value).toBe('20260429-141522-');
  });

  it('rejects uppercase in the slug suffix', () => {
    const r = SprintId.parse('20260429-141522-Foo');
    expect(r.ok).toBe(false);
  });

  it('rejects trailing hyphen in slug suffix', () => {
    const r = SprintId.parse('20260429-141522-foo-');
    expect(r.ok).toBe(false);
  });

  it('rejects non-string input', () => {
    const r = SprintId.parse(20260429);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe('sprint-id');
  });

  it('create() formats a real Date + Slug into a parseable id (UTC)', () => {
    const slugR = Slug.parse('my-sprint');
    expect(slugR.ok).toBe(true);
    if (!slugR.ok) return;

    // Pick a UTC instant explicitly so the result is deterministic.
    const date = new Date(Date.UTC(2026, 3 /* April */, 29, 14, 15, 22));
    const id = SprintId.create(date, slugR.value);
    expect(id).toBe('20260429-141522-my-sprint');
    expect(SprintId.parse(id).ok).toBe(true);
  });

  it('create() pads single-digit components', () => {
    const slugR = Slug.parse('x');
    if (!slugR.ok) throw new Error('precondition failed');
    const date = new Date(Date.UTC(2024, 0 /* Jan */, 1, 0, 0, 0));
    const id = SprintId.create(date, slugR.value);
    expect(id).toBe('20240101-000000-x');
  });

  it('SprintId is brand-distinct from other id-like strings', () => {
    const sR = SprintId.parse('20260429-141522-x');
    const tR = TicketId.parse('deadbeef');
    expect(sR.ok && tR.ok).toBe(true);
    if (!sR.ok || !tR.ok) return;

    const sprint: SprintId = sR.value;
    const ticket: TicketId = tR.value;

    // @ts-expect-error TicketId is not assignable to SprintId
    const _bad1: SprintId = ticket;
    // @ts-expect-error SprintId is not assignable to TicketId
    const _bad2: TicketId = sprint;

    void _bad1;
    void _bad2;
  });

  it('trustString returns the input typed as a SprintId', () => {
    const id: SprintId = SprintId.trustString('20260429-141522-validated');
    expect(id).toBe('20260429-141522-validated');
  });
});
