import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';

/**
 * Output port for reading the trailing N bytes of a UTF-8 log file. Used by TUI hover /
 * expand surfaces to lazy-load the body of a {@link SetupRun} or {@link VerifyRun} audit
 * row whose full output lives under `<sprintDir>/logs/...` (audit-[01]) — without
 * persisting the body on the row itself.
 *
 * Returns `undefined` when the file is absent (a normal outcome — the row may pre-date the
 * audit-[01] logs/ layout, or the script outcome was `skipped`/`spawn-error` and produced
 * no body). On read errors the adapter logs warn and also returns `undefined`; this is a
 * display-only port so a missing file must not crash the TUI.
 *
 * Concrete adapter at `integration/io/read-log-tail.ts` caps the read at a small constant
 * (`DEFAULT_LOG_TAIL_BYTES`) so the host never streams an unbounded body into memory just
 * to render a popover.
 */
export type LogTailReader = (path: AbsolutePath, maxBytes?: number) => Promise<string | undefined>;
