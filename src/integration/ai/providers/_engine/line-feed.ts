/**
 * Shared `feed`/`flush` NDJSON line-splitting loop for the stdout stream parsers
 * (`claude/parse-stream.ts`, `copilot/parse-stream.ts`). Both parsers accumulate a local
 * `buffer`, cap it via {@link createCappedAppend} to guard against an OOM-class unterminated-line
 * accumulation (see `bounded-tail.ts`), split on `\n` in a loop, and hand each complete line to a
 * parser-specific `emitLine` callback that closes over that parser's own state. That loop was
 * byte-identical in both siblings — unified here so they can't drift; only the per-line emit
 * function (and its output line type) stays parser-local.
 *
 * @public
 */

import { createCappedAppend } from '@src/integration/ai/providers/_engine/bounded-tail.ts';

/**
 * Build a capped NDJSON `feed`/`flush` pair. `emitLine` receives each complete (feed) or trailing
 * partial (flush) raw line and reports zero or more parsed lines via `onLine`.
 */
export const createCappedLineFeed = <L>(
  streamLabel: string,
  emitLine: (raw: string, onLine: (line: L) => void) => void
): {
  feed(chunk: string, onLine: (line: L) => void): void;
  flush(onLine: (line: L) => void): void;
} => {
  let buffer = '';
  // Cap the in-flight line accumulator. A single NDJSON record embedding a large file-read /
  // bash tool result can grow `buffer` to tens of MB before its newline clears it — an OOM-class
  // accumulation. `feed` is the SOLE append site, so capping here keeps the invariant for `flush`
  // too (it only drains an already-bounded buffer). Shared impl — see `createCappedAppend`
  // (drop-oldest, one-shot warn).
  const appendCapped = createCappedAppend(streamLabel);

  return {
    feed(chunk, onLine) {
      buffer = appendCapped(buffer, chunk);
      let nl = buffer.indexOf('\n');
      while (nl !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        emitLine(line, onLine);
        nl = buffer.indexOf('\n');
      }
    },
    flush(onLine) {
      if (buffer.length > 0) {
        emitLine(buffer, onLine);
        buffer = '';
      }
    },
  };
};
