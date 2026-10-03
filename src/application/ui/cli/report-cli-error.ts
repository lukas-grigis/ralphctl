import { RALPHCTL_DEBUG_TRACE_ENV } from '@src/application/bootstrap/wire.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import { messageOf } from '@src/domain/value/error/error-message.ts';

/** Shared CLI failure reporter — a failed command branch calls `fail(message); return;` instead of writing stderr itself. */
export const fail = (message: string): void => {
  process.stderr.write(`error: ${message}\n`);
  process.exitCode = 1;
};

/** Cancellation exit code — 128 + SIGINT, the shell convention. */
const EXIT_INTERRUPTED = 130;

/**
 * Terminal-frame reporter for anything that escapes a command action.
 * @public
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
