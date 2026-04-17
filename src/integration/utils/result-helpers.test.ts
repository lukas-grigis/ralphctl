import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Result } from 'typescript-result';
import { ValidationError } from '@src/domain/errors.ts';
import { ensureError, unwrapOrThrow, wrapAsync, zodParse } from './result-helpers.ts';

describe('wrapAsync', () => {
  it('returns Ok on success', async () => {
    const result = await wrapAsync(() => Promise.resolve(42), ensureError);
    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toBe(42);
  });

  it('returns Error when function throws an Error', async () => {
    const result = await wrapAsync(() => Promise.reject(new Error('boom')), ensureError);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.message).toBe('boom');
  });

  it('returns Error when function throws a non-Error', async () => {
    const result = await wrapAsync(
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      () => Promise.reject('string error'),
      ensureError
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.message).toBe('string error');
  });

  it('uses custom mapError when provided', async () => {
    const result = await wrapAsync(
      () => Promise.reject(new Error('original')),
      () => new Error('mapped')
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.message).toBe('mapped');
  });
});

describe('zodParse', () => {
  const schema = z.object({ name: z.string(), age: z.number() });

  it('returns Ok for valid input', () => {
    const result = zodParse(schema, { name: 'Ralph', age: 8 });
    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toEqual({ name: 'Ralph', age: 8 });
  });

  it('returns ValidationError for invalid input', () => {
    const result = zodParse(schema, { name: 123 }, 'test-label');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ValidationError);
      expect(result.error.path).toBe('test-label');
    }
  });
});

describe('unwrapOrThrow', () => {
  it('returns value for Ok result', () => {
    const result = Result.ok('hello');
    expect(unwrapOrThrow(result)).toBe('hello');
  });

  it('throws for Error result', () => {
    const result = Result.error(new Error('fail'));
    expect(() => unwrapOrThrow(result)).toThrow('fail');
  });
});

describe('ensureError', () => {
  it('passes through Error instances', () => {
    const err = new Error('test');
    expect(ensureError(err)).toBe(err);
  });

  it('wraps string values in Error', () => {
    const result = ensureError('string error');
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('string error');
  });

  it('wraps objects in Error via String()', () => {
    const result = ensureError({ code: 42 });
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('[object Object]');
  });

  it('wraps null and undefined', () => {
    expect(ensureError(null).message).toBe('null');
    expect(ensureError(undefined).message).toBe('undefined');
  });
});
