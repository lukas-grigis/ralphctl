import { describe, expect, it } from 'vitest';

import type { DomainError } from './domain-error.ts';
import { StorageError } from './storage-error.ts';

describe('StorageError', () => {
  it('has the kebab-case discriminator code', () => {
    const err = new StorageError({ subCode: 'io', message: 'read failed' });
    expect(err.code).toBe('storage-error');
  });

  it('preserves the subCode discriminator', () => {
    const sub = ['io', 'lock', 'parse', 'schema-mismatch', 'no-changes'] as const;
    for (const subCode of sub) {
      const err = new StorageError({ subCode, message: 'm' });
      expect(err.subCode).toBe(subCode);
    }
  });

  it('supports the "no-changes" sub-code distinct from "io"', () => {
    // Callers (e.g. stashChanges on an already-clean tree) detect the
    // no-op via this discriminator instead of message-string matching.
    const err = new StorageError({ subCode: 'no-changes', message: 'no changes' });
    expect(err.subCode).toBe('no-changes');
    expect(err.code).toBe('storage-error');
  });

  it('uses the supplied message verbatim (no default)', () => {
    const err = new StorageError({
      subCode: 'parse',
      message: 'tasks.json contained invalid JSON',
    });
    expect(err.message).toBe('tasks.json contained invalid JSON');
  });

  it('copies through optional path and cause', () => {
    const cause = new Error('ENOENT');
    const err = new StorageError({
      subCode: 'io',
      message: 'open failed',
      path: '/abs/path/sprint.json',
      cause,
    });
    expect(err.path).toBe('/abs/path/sprint.json');
    expect(err.cause).toBe(cause);
  });

  it('leaves path and cause undefined when omitted', () => {
    const err = new StorageError({ subCode: 'lock', message: 'stale lock' });
    expect(err.path).toBeUndefined();
    expect(err.cause).toBeUndefined();
  });

  it('is an instance of Error and structurally a KernelError', () => {
    const err = new StorageError({ subCode: 'schema-mismatch', message: 'bad shape' });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('StorageError');
    expect(typeof err.code).toBe('string');
    expect(typeof err.message).toBe('string');
  });

  it('satisfies the DomainError union (compile-time)', () => {
    const err: DomainError = new StorageError({ subCode: 'io', message: 'm' });
    expect(err.code).toBe('storage-error');
  });

  it('round-trips an optional hint when provided', () => {
    const err = new StorageError({
      subCode: 'lock',
      message: 'stale lock',
      hint: 'Wait or remove the lock file if stale.',
    });
    expect(err.hint).toBe('Wait or remove the lock file if stale.');
  });

  it('leaves hint undefined when omitted', () => {
    const err = new StorageError({ subCode: 'io', message: 'oops' });
    expect(err.hint).toBeUndefined();
  });
});
