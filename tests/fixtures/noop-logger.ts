import type { Logger } from '@src/business/observability/logger.ts';

/**
 * Logger that drops every record on the floor. Default for tests and any test
 * fixture constructing entities during setup. Production code is always handed
 * a real logger via `wire()` — this fixture must not be imported from `src/`.
 */
export const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  named() {
    return noopLogger;
  },
};
