import { describe, expect, it } from 'vitest';
import { isRecord, numberField, stringField } from '@src/integration/ai/providers/_engine/json-field.ts';

describe('stringField', () => {
  it('returns the value when the first candidate is a string', () => {
    expect(stringField({ a: 'hello' }, 'a')).toBe('hello');
  });

  it('returns the first matching candidate name when multiple candidates present', () => {
    expect(stringField({ a: 'first', b: 'second' }, 'a', 'b')).toBe('first');
  });

  it('skips non-matching candidates and returns the first string-valued one', () => {
    expect(stringField({ a: 42, b: 'found' }, 'a', 'b')).toBe('found');
  });

  it('skips number-valued candidates', () => {
    expect(stringField({ a: 99 }, 'a')).toBeUndefined();
  });

  it('skips boolean-valued candidates', () => {
    expect(stringField({ a: true }, 'a')).toBeUndefined();
  });

  it('skips object-valued candidates', () => {
    expect(stringField({ a: { nested: 1 } }, 'a')).toBeUndefined();
  });

  it('skips null-valued candidates', () => {
    expect(stringField({ a: null }, 'a')).toBeUndefined();
  });

  it('skips undefined-valued candidates', () => {
    expect(stringField({ a: undefined }, 'a')).toBeUndefined();
  });

  it('returns undefined when no candidate name matches', () => {
    expect(stringField({ x: 'hello' }, 'a', 'b')).toBeUndefined();
  });

  it('treats the empty string as a valid present value (not skipped)', () => {
    expect(stringField({ a: '' }, 'a')).toBe('');
  });

  it('candidate-order precedence: first matching name wins', () => {
    // mirrors real provider usage where key order is load-bearing
    expect(stringField({ session_id: 'sid', sessionId: 'camelId' }, 'session_id', 'sessionId')).toBe('sid');
    expect(stringField({ sessionId: 'camelId' }, 'session_id', 'sessionId')).toBe('camelId');
  });
});

describe('numberField', () => {
  it('returns the value when the first candidate is a finite number', () => {
    expect(numberField({ a: 42 }, 'a')).toBe(42);
  });

  it('returns the first matching candidate name when multiple candidates present', () => {
    expect(numberField({ a: 1, b: 2 }, 'a', 'b')).toBe(1);
  });

  it('skips non-matching candidates and returns the first finite-number one', () => {
    expect(numberField({ a: 'not-a-number', b: 7 }, 'a', 'b')).toBe(7);
  });

  it('treats 0 as a valid present value', () => {
    expect(numberField({ a: 0 }, 'a')).toBe(0);
  });

  it('rejects NaN via the Number.isFinite gate', () => {
    expect(numberField({ a: NaN }, 'a')).toBeUndefined();
  });

  it('rejects Infinity', () => {
    expect(numberField({ a: Infinity }, 'a')).toBeUndefined();
  });

  it('rejects -Infinity', () => {
    expect(numberField({ a: -Infinity }, 'a')).toBeUndefined();
  });

  it('rejects numeric strings', () => {
    expect(numberField({ a: '42' }, 'a')).toBeUndefined();
  });

  it('rejects null', () => {
    expect(numberField({ a: null }, 'a')).toBeUndefined();
  });

  it('returns undefined when no candidate name matches', () => {
    expect(numberField({ x: 5 }, 'a', 'b')).toBeUndefined();
  });

  it('candidate-order precedence: first matching name wins', () => {
    // mirrors codex reading 'thread_id' before 'session_id' before 'sessionId'
    expect(numberField({ thread_id: 1, session_id: 2 }, 'thread_id', 'session_id')).toBe(1);
    expect(numberField({ session_id: 2 }, 'thread_id', 'session_id')).toBe(2);
  });
});

describe('isRecord', () => {
  it('returns true for a plain object', () => {
    expect(isRecord({ a: 1 })).toBe(true);
  });

  it('returns true for an empty object', () => {
    expect(isRecord({})).toBe(true);
  });

  it('returns true for arrays (typeof [] === "object")', () => {
    expect(isRecord([])).toBe(true);
    expect(isRecord([1, 2, 3])).toBe(true);
  });

  it('returns false for null', () => {
    expect(isRecord(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isRecord(undefined)).toBe(false);
  });

  it('returns false for strings', () => {
    expect(isRecord('hello')).toBe(false);
  });

  it('returns false for numbers', () => {
    expect(isRecord(42)).toBe(false);
  });

  it('returns false for booleans', () => {
    expect(isRecord(true)).toBe(false);
    expect(isRecord(false)).toBe(false);
  });
});
