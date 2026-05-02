import { describe, expect, it } from 'vitest';

import { ConflictError } from './conflict-error.ts';

describe('ConflictError', () => {
  it('has the kebab-case discriminator code', () => {
    const err = new ConflictError({ entity: 'ticket', conflictingId: 'abc12345' });
    expect(err.code).toBe('conflict');
  });

  it('builds a default message from entity + conflicting id', () => {
    const err = new ConflictError({ entity: 'ticket', conflictingId: 'abc12345' });
    expect(err.message).toBe("ticket with id 'abc12345' already exists");
  });

  it('honours an explicit message override', () => {
    const err = new ConflictError({
      entity: 'repository',
      conflictingId: '/abs/path',
      message: 'repository path already registered on this project',
    });
    expect(err.message).toBe('repository path already registered on this project');
  });

  it('preserves typed context fields', () => {
    const err = new ConflictError({ entity: 'repository', conflictingId: '/abs/p' });
    expect(err.entity).toBe('repository');
    expect(err.conflictingId).toBe('/abs/p');
    expect(err.name).toBe('ConflictError');
  });

  it('is an instance of Error and structurally a KernelError', () => {
    const err = new ConflictError({ entity: 'ticket', conflictingId: 'deadbeef' });
    expect(err).toBeInstanceOf(Error);
    expect(typeof err.code).toBe('string');
    expect(typeof err.message).toBe('string');
  });

  it('round-trips an optional hint when provided', () => {
    const err = new ConflictError({
      entity: 'ticket',
      conflictingId: 'abc12345',
      hint: 'Use ticket edit to modify it.',
    });
    expect(err.hint).toBe('Use ticket edit to modify it.');
  });

  it('leaves hint undefined when omitted', () => {
    const err = new ConflictError({ entity: 'ticket', conflictingId: 'abc12345' });
    expect(err.hint).toBeUndefined();
  });
});
