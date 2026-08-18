import { RALPHCTL_DEBUG_TRACE_ENV } from '@src/application/bootstrap/wire.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';

/**
 * Shared CLI failure reporter — every command action ends a failed branch with
 * `fail(message); return;` (or `return <value>;` in a helper with a non-`void` return type)
 * instead of hand-rolling the `process.stderr.write` + `process.exitCode = 1` pair. Consolidates
 * the `error: ` prefix and trailing newline in one place so every command's stderr output stays
 * byte-identical to what it was before this was extracted.
 */
export const fail = (message: string): void => {
  process.stderr.write(`error: ${message}\n`);
  process.exitCode = 1;
};

/** Cancellation exit code — 128 + SIGINT, the shell convention. */
const EXIT_INTERRUPTED = 130;

/**
 * Terminal-frame reporter for anything that escapes a command action — chiefly the pre-flight
 * throws in `bootstrapCli` (storage-paths / ensure-roots / settings / bundle-integrity), which
 * are the failures an operator hits when the install or the config is broken. Without this, Node's
 * uncaught-exception handler prints a source excerpt from the bundled `dist/cli-<hash>.mjs`, a full
 * commander stack and a `Node.js v<x>` footer — the exact output `ralphctl doctor` must not produce
 * when doctor is the command you run BECAUSE something is wrong. Mirrors the TUI's equivalent
 * (`tui/launch.ts`).
 *
 * `AbortError` is handled here rather than re-thrown. The propagation rule ("a guard or fallback
 * that catches errors must exempt AbortError") exists so a mid-chain catch cannot swallow
 * cancellation and let an inner layer keep going; this is the process boundary, there is nothing
 * left to propagate to, and a re-throw would reproduce the raw crash banner this reporter exists to
 * prevent. Do not "fix" it back into a re-throw.
 *
 * The stack stays available behind `RALPHCTL_DEBUG_TRACE` — the same flag that turns on the
 * chain.log debug sink — so maintainers keep the detail without inflicting it on operators.
 *
 * @public
 */
export const reportFatal = (err: unknown): void => {
  if (err instanceof AbortError) {
    process.stderr.write('ralphctl: cancelled\n');
    process.exitCode = EXIT_INTERRUPTED;
    return;
  }

  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`ralphctl: ${message.trim()}\n`);

  const debug = process.env[RALPHCTL_DEBUG_TRACE_ENV];
  if (typeof debug === 'string' && debug.length > 0 && err instanceof Error && err.stack !== undefined) {
    process.stderr.write(`${err.stack}\n`);
  } else {
    process.stderr.write(`ralphctl: re-run with ${RALPHCTL_DEBUG_TRACE_ENV}=1 for the full stack\n`);
  }

  process.exitCode = 1;
};
