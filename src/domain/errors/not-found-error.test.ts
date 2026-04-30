import { describe, expect, it } from 'vitest';

import type { DomainError } from './domain-error.ts';
import { NotFoundError } from './not-found-error.ts';

describe('NotFoundError', () => {
  it('has the kebab-case discriminator code', () => {
    const err = new NotFoundError({ entity: 'sprint', id: '20260429-141522-x' });
    expect(err.code).toBe('not-found');
  });

  it('builds a default message from entity + id', () => {
    const err = new NotFoundError({ entity: 'sprint', id: '20260429-141522-x' });
    expect(err.message).toBe("sprint '20260429-141522-x' not found");
  });

  it('honours an explicit message override', () => {
    const err = new NotFoundError({
      entity: 'task',
      id: 'deadbeef',
      message: 'task missing from sprint task set',
    });
    expect(err.message).toBe('task missing from sprint task set');
  });

  it('preserves typed context fields', () => {
    const err = new NotFoundError({ entity: 'project', id: 'my-proj' });
    expect(err.entity).toBe('project');
    expect(err.id).toBe('my-proj');
    expect(err.name).toBe('NotFoundError');
  });

  it('is an instance of Error and structurally a KernelError', () => {
    const err = new NotFoundError({ entity: 'ticket', id: 'abcd1234' });
    expect(err).toBeInstanceOf(Error);
    expect(typeof err.code).toBe('string');
    expect(typeof err.message).toBe('string');
  });

  it('satisfies the DomainError union (compile-time)', () => {
    const err: DomainError = new NotFoundError({ entity: 'sprint', id: 'x' });
    // Use a non-trivial assertion so the compiler retains the binding.
    expect(err.code).toBe('not-found');
  });
});
