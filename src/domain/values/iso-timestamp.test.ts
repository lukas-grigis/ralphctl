import { describe, expect, it } from 'vitest';

import { IsoTimestamp } from './iso-timestamp.ts';
import { SprintId } from './sprint-id.ts';

describe('IsoTimestamp', () => {
  it('accepts a Z-suffixed timestamp', () => {
    const r = IsoTimestamp.parse('2026-04-29T14:15:22Z');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe('2026-04-29T14:15:22Z');
  });

  it('accepts a positive numeric offset', () => {
    const r = IsoTimestamp.parse('2026-04-29T14:15:22+02:00');
    expect(r.ok).toBe(true);
  });

  it('accepts a negative numeric offset', () => {
    const r = IsoTimestamp.parse('2026-04-29T14:15:22-05:30');
    expect(r.ok).toBe(true);
  });

  it('accepts millisecond precision with Z', () => {
    const r = IsoTimestamp.parse('2026-04-29T14:15:22.123Z');
    expect(r.ok).toBe(true);
  });

  it('rejects a date-only string', () => {
    const r = IsoTimestamp.parse('2026-04-29');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.field).toBe('iso-timestamp');
      expect(r.error.value).toBe('2026-04-29');
    }
  });

  it('rejects timestamps without offset', () => {
    const r = IsoTimestamp.parse('2026-04-29T14:15:22');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe('iso-timestamp');
  });

  it('rejects nonsense strings', () => {
    const r = IsoTimestamp.parse('not-a-date');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.value).toBe('not-a-date');
  });

  it('rejects non-string input', () => {
    const r = IsoTimestamp.parse(Date.now());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe('iso-timestamp');
  });

  it('now() returns a parseable IsoTimestamp', () => {
    const ts = IsoTimestamp.now();
    expect(ts.endsWith('Z')).toBe(true);
    expect(IsoTimestamp.parse(ts).ok).toBe(true);
  });

  it('fromDate() returns a parseable IsoTimestamp', () => {
    const date = new Date(Date.UTC(2026, 3, 29, 14, 15, 22));
    const ts = IsoTimestamp.fromDate(date);
    expect(ts).toBe('2026-04-29T14:15:22.000Z');
    expect(IsoTimestamp.parse(ts).ok).toBe(true);
  });

  it('IsoTimestamp is brand-distinct from other VOs', () => {
    const tsR = IsoTimestamp.parse('2026-04-29T14:15:22Z');
    const sR = SprintId.parse('20260429-141522-x');
    expect(tsR.ok && sR.ok).toBe(true);
    if (!tsR.ok || !sR.ok) return;

    const ts: IsoTimestamp = tsR.value;
    const sprint: SprintId = sR.value;

    // @ts-expect-error SprintId is not assignable to IsoTimestamp
    const _bad1: IsoTimestamp = sprint;
    // @ts-expect-error IsoTimestamp is not assignable to SprintId
    const _bad2: SprintId = ts;

    void _bad1;
    void _bad2;
  });

  it('trustString returns the input typed as an IsoTimestamp', () => {
    const ts: IsoTimestamp = IsoTimestamp.trustString('2026-04-29T14:15:22Z');
    expect(ts).toBe('2026-04-29T14:15:22Z');
  });
});
