import { RALPHCTL_DEBUG_TRACE_ENV } from '@src/application/bootstrap/wire.ts';
import type { Result } from '@src/domain/result.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import { messageOf } from '@src/domain/value/error/error-message.ts';

/** Shared CLI failure reporter — a failed command branch calls `fail(message); return;` instead of writing stderr itself. */
export const fail = (message: string): void => {
  process.stderr.write(`error: ${message}\n`);
  process.exitCode = 1;
};

/** Narrowing guard for the fail-and-return idiom: `if (!okOrFail(r)) return;` reports `prefix + error.message` on failure. */
export const okOrFail = <R extends Result<unknown, { readonly message: string }>>(
  r: R,
  prefix = ''
): r is Extract<R, { readonly ok: true }> => {
  if (!r.ok) fail(prefix + r.error.message);
  return r.ok;
};

/** Cancellation exit code — 128 + SIGINT, the shell convention. */
const EXIT_INTERRUPTED = 130;

/**
 * Terminal-frame reporter for anything that escapes a command action.
 */
export const reportFatal = (err: unknown): void => {
  if (err instanceof AbortError) {
    process.stderr.write('ralphctl: cancelled\n');
    process.exitCode = EXIT_INTERRUPTED;
    return;
  }

  const message = messageOf(err);
  process.stderr.write(`ralphctl: ${message.trim()}\n`);

  const debug = process.env[RALPHCTL_DEBUG_TRACE_ENV];
  if (typeof debug === 'string' && debug.length > 0 && err instanceof Error && err.stack !== undefined) {
    process.stderr.write(`${err.stack}\n`);
  } else {
    process.stderr.write(`ralphctl: re-run with ${RALPHCTL_DEBUG_TRACE_ENV}=1 for the full stack\n`);
  }

  process.exitCode = 1;
};
