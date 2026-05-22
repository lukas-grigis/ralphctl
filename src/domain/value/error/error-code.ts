export const ErrorCode = {
  InvalidValue: 'invalid-value',
  NotFound: 'not-found',
  Conflict: 'conflict',
  InvalidState: 'invalid-state',
  Parse: 'parse-error',
  RateLimit: 'rate-limit',
  Storage: 'storage-error',
  Probe: 'probe-error',
  Aborted: 'aborted',
  MigrationGap: 'migration-gap',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
