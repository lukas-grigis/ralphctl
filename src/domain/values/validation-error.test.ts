import { describe, expect, it } from 'vitest';

import { ValidationError } from './validation-error.ts';

describe('ValidationError', () => {
  it('is an Error subclass with a stable code discriminator', () => {
    const err = new ValidationError({ field: 'x', value: 1, message: 'bad' });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.code).toBe('invalid-value');
    expect(err.name).toBe('ValidationError');
  });

  it('carries the failing field, value, and message', () => {
    const err = new ValidationError({
      field: 'absolute-path',
      value: './rel',
      message: 'path must be absolute',
    });
    expect(err.field).toBe('absolute-path');
    expect(err.value).toBe('./rel');
    expect(err.message).toBe('path must be absolute');
    expect(err.hint).toBeUndefined();
  });

  it('preserves an optional hint when provided', () => {
    const err = new ValidationError({
      field: 'sprint-id',
      value: 'oops',
      message: 'invalid format',
      hint: 'expected YYYYMMDD-HHmmss-<slug>',
    });
    expect(err.hint).toBe('expected YYYYMMDD-HHmmss-<slug>');
  });

  it('satisfies the kernel KernelError shape (code + message)', () => {
    // Structural — assignable to a {code, message} target.
    const err = new ValidationError({ field: 'f', value: null, message: 'm' });
    const asKernel: { readonly code: string; readonly message: string } = err;
    expect(asKernel.code).toBe('invalid-value');
    expect(asKernel.message).toBe('m');
  });
});
