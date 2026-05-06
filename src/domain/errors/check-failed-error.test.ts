import { describe, expect, it } from 'vitest';

import { CheckFailedError } from './check-failed-error.ts';

describe('CheckFailedError', () => {
  it('has the kebab-case discriminator code', () => {
    const err = new CheckFailedError({ output: '3 tests failing' });
    expect(err.code).toBe('check-failed');
  });

  it('builds a default message when none is provided', () => {
    const err = new CheckFailedError({ output: '' });
    expect(err.message).toBe('post-task check script failed');
  });

  it('honours an explicit message override', () => {
    const err = new CheckFailedError({ output: 'oops', message: 'lint failed' });
    expect(err.message).toBe('lint failed');
  });

  it('preserves the captured output', () => {
    const err = new CheckFailedError({ output: 'FAIL src/foo.test.ts' });
    expect(err.output).toBe('FAIL src/foo.test.ts');
    expect(err.name).toBe('CheckFailedError');
  });

  it('is an instance of Error and structurally a KernelError', () => {
    const err = new CheckFailedError({ output: 'x' });
    expect(err).toBeInstanceOf(Error);
    expect(typeof err.code).toBe('string');
    expect(typeof err.message).toBe('string');
  });

  it('attaches an optional cause', () => {
    const root = new Error('exit 1');
    const err = new CheckFailedError({ output: '', cause: root });
    expect((err as { cause?: unknown }).cause).toBe(root);
  });
});
