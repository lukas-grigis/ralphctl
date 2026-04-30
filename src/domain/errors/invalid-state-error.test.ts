import { describe, expect, it } from 'vitest';

import { InvalidStateError } from './invalid-state-error.ts';

describe('InvalidStateError', () => {
  it('has the kebab-case discriminator code', () => {
    const err = new InvalidStateError({
      entity: 'sprint',
      currentState: 'closed',
      attemptedAction: 'add-ticket',
    });
    expect(err.code).toBe('invalid-state');
  });

  it('builds a default message from entity / state / action', () => {
    const err = new InvalidStateError({
      entity: 'task',
      currentState: 'todo',
      attemptedAction: 'mark-done',
    });
    expect(err.message).toBe("cannot mark-done on task in state 'todo'");
  });

  it('honours an explicit message override', () => {
    const err = new InvalidStateError({
      entity: 'ticket',
      currentState: 'approved',
      attemptedAction: 'approve-requirements',
      message: 'requirements are already approved',
    });
    expect(err.message).toBe('requirements are already approved');
  });

  it('preserves typed context fields', () => {
    const err = new InvalidStateError({
      entity: 'sprint',
      currentState: 'draft',
      attemptedAction: 'close',
    });
    expect(err.entity).toBe('sprint');
    expect(err.currentState).toBe('draft');
    expect(err.attemptedAction).toBe('close');
    expect(err.name).toBe('InvalidStateError');
  });

  it('is an instance of Error and structurally a KernelError', () => {
    const err = new InvalidStateError({
      entity: 'sprint',
      currentState: 'closed',
      attemptedAction: 'reopen',
    });
    expect(err).toBeInstanceOf(Error);
    expect(typeof err.code).toBe('string');
    expect(typeof err.message).toBe('string');
  });
});
