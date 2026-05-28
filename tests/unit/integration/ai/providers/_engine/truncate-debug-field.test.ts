import { describe, expect, it } from 'vitest';
import { truncateField } from '@src/integration/ai/providers/_engine/truncate-debug-field.ts';

describe('truncateField', () => {
  it('passes a short string through unchanged', () => {
    expect(truncateField('hello')).toBe('hello');
  });

  it('passes an exact-cap string through unchanged (boundary, no ellipsis)', () => {
    const exact = 'a'.repeat(120);
    expect(truncateField(exact)).toBe(exact);
    expect(truncateField(exact, 120)).toBe(exact);
  });

  it('truncates over-cap strings to max length + the U+2026 horizontal ellipsis', () => {
    const over = 'b'.repeat(121);
    const out = truncateField(over);
    expect(out).toBe(`${'b'.repeat(120)}…`);
    // The ellipsis is one code point ('…' / U+2026), not three ASCII dots.
    expect(out?.endsWith('…')).toBe(true);
    expect(out?.endsWith('...')).toBe(false);
  });

  it('honours a custom max cap', () => {
    expect(truncateField('hello world', 5)).toBe('hello…');
  });

  it('returns undefined for undefined input', () => {
    expect(truncateField(undefined)).toBeUndefined();
  });

  it('returns undefined for empty string input', () => {
    expect(truncateField('')).toBeUndefined();
  });
});
