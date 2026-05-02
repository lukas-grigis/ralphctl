import { describe, expect, it } from 'vitest';

import type { DomainError } from './domain-error.ts';
import { ParseError } from './parse-error.ts';

describe('ParseError', () => {
  it('has the kebab-case discriminator code', () => {
    const err = new ParseError({ subCode: 'invalid-json', message: 'bad json' });
    expect(err.code).toBe('parse-error');
  });

  it('preserves the subCode discriminator', () => {
    for (const subCode of ['invalid-json', 'schema-mismatch'] as const) {
      const err = new ParseError({ subCode, message: 'm' });
      expect(err.subCode).toBe(subCode);
    }
  });

  it('uses the supplied message verbatim', () => {
    const err = new ParseError({ subCode: 'invalid-json', message: 'expected fenced JSON block' });
    expect(err.message).toBe('expected fenced JSON block');
  });

  it('preserves cause', () => {
    const cause = new SyntaxError('Unexpected token');
    const err = new ParseError({ subCode: 'invalid-json', message: 'bad', cause });
    expect(err.cause).toBe(cause);
  });

  it('round-trips an optional hint when provided', () => {
    const err = new ParseError({
      subCode: 'schema-mismatch',
      message: 'AI output failed schema',
      hint: 'Re-run, or check the session log.',
    });
    expect(err.hint).toBe('Re-run, or check the session log.');
  });

  it('leaves hint undefined when omitted', () => {
    const err = new ParseError({ subCode: 'invalid-json', message: 'bad' });
    expect(err.hint).toBeUndefined();
  });

  it('is an instance of Error and structurally a KernelError', () => {
    const err = new ParseError({ subCode: 'invalid-json', message: 'bad' });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ParseError');
  });

  it('satisfies the DomainError union (compile-time)', () => {
    const err: DomainError = new ParseError({ subCode: 'invalid-json', message: 'm' });
    expect(err.code).toBe('parse-error');
  });
});
