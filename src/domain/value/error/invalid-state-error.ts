import { ErrorCode } from '@src/domain/value/error/error-code.ts';

/**
 * `currentState` values a provider adapter stamps when the CLI rejected the run's configuration
 * (not a transient death). Non-retryable: the next attempt would send the same config. The implement
 * turn policy keys on these to name the settings field to fix instead of blaming signals.json.
 */
export const ProviderConfigRejection = {
  ModelUnavailable: 'model-unavailable',
  EffortUnsupported: 'effort-unsupported',
} as const;

export type ProviderConfigRejection = (typeof ProviderConfigRejection)[keyof typeof ProviderConfigRejection];

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
