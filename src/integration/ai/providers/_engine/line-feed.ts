/**
 * Shared NDJSON plumbing for the five stdout stream parsers: the capped `feed`/`flush`
 * line-splitting loop ({@link createCappedLineFeed}) plus the JSON-object line parser the
 * codex / grok / opencode emitters share ({@link parseJsonObjectLine}, {@link emitJsonObjectLine}).
 *
 * @public
 */

import { createCappedAppend } from '@src/integration/ai/providers/_engine/bounded-tail.ts';

// Normalise the line ending. We split on `\n` only, so a CRLF stream (a Windows-hosted CLI, or a
// PTY that translates `\n` → `\r\n`) leaves a trailing `\r` on every line. That one byte used to
// defeat the JSON guards in the claude / copilot emitters — every record fell through to the
// plain-text branch and session-id, body and usage were all silently lost. Stripping here keeps
// both the parse path and the `line.raw` debug fan-out looking at the same normalised string.
const stripCr = (line: string): string => (line.endsWith('\r') ? line.slice(0, -1) : line);

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
        const line = stripCr(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        emitLine(line, onLine);
        nl = buffer.indexOf('\n');
      }
    },
    flush(onLine) {
      if (buffer.length > 0) {
        const line = stripCr(buffer);
        buffer = '';
        emitLine(line, onLine);
      }
    },
  };
};

/**
 * Trim + JSON.parse one stdout line. `undefined` for blank, non-object-looking, and unparseable
 * lines — CLIs print banner text alongside JSON records, so a parse failure is expected noise.
 */
export const parseJsonObjectLine = (line: string): Record<string, unknown> | undefined => {
  const trimmed = line.trim();
  if (trimmed.length === 0 || !trimmed.startsWith('{')) return undefined;
  try {
    // Callers narrow every field they read through `json-field.ts` helpers; unknown shapes are skipped.
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return undefined;
  }
};

/** {@link createCappedLineFeed} emitter for JSONL streams: one parsed object per line, none for noise. */
export const emitJsonObjectLine = (raw: string, onLine: (obj: Record<string, unknown>) => void): void => {
  const obj = parseJsonObjectLine(raw);
  if (obj !== undefined) onLine(obj);
};
