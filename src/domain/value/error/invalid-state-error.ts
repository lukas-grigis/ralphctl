import { ErrorCode } from '@src/domain/value/error/error-code.ts';

export interface InvalidStateErrorOptions {
  readonly entity: string;
  readonly currentState: string;
  readonly attemptedAction: string;
  readonly message?: string;
  readonly hint?: string;
}

export class InvalidStateError extends Error {
  readonly code = ErrorCode.InvalidState;
  readonly entity: string;
  readonly currentState: string;
  readonly attemptedAction: string;
  readonly hint?: string;

  constructor(opts: InvalidStateErrorOptions) {
    super(opts.message ?? `cannot ${opts.attemptedAction} on ${opts.entity} in state '${opts.currentState}'`);
    this.name = 'InvalidStateError';
    this.entity = opts.entity;
    this.currentState = opts.currentState;
    this.attemptedAction = opts.attemptedAction;
    if (opts.hint !== undefined) {
      this.hint = opts.hint;
    }
  }
}
