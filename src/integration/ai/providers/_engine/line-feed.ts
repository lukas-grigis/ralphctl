/**
 * Shared NDJSON plumbing for the five stdout stream parsers: the capped `feed`/`flush` line
 * splitter plus the JSON-object line parser.
 */

/**
 * Ceiling on the in-flight (unterminated) line. One record embedding a large file-read or bash
 * result can otherwise grow the buffer to tens of MB before its newline arrives.
 */
export const STDOUT_LINE_PARSE_CAP = 524_288;

// We split on `\n` only, so a CRLF stream leaves a trailing `\r` that would defeat the JSON guards.
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
  let overflowWarned = false;
  // Keep the TAIL on overflow so the record's terminating newline still lands in the window; warn once.
  const appendCapped = (chunk: string): void => {
    buffer += chunk;
    if (buffer.length <= STDOUT_LINE_PARSE_CAP) return;
    if (!overflowWarned) {
      overflowWarned = true;
      console.warn(
        `[${streamLabel}] in-flight NDJSON line exceeded ${String(STDOUT_LINE_PARSE_CAP)} bytes — ` +
          'truncating the parse buffer to its tail and continuing. A single record is streaming an ' +
          'oversized tool result; the affected line will be emitted as a raw (unparsed) text line.'
      );
    }
    buffer = buffer.slice(-STDOUT_LINE_PARSE_CAP);
  };

  return {
    feed(chunk, onLine) {
      appendCapped(chunk);
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) emitLine(stripCr(line), onLine);
    },
    flush(onLine) {
      if (buffer.length === 0) return;
      const line = stripCr(buffer);
      buffer = '';
      emitLine(line, onLine);
    },
  };
};

/**
 * Trim + JSON.parse one stdout line. `undefined` for blank, non-object-looking, and unparseable
 * lines — CLIs print banner text alongside JSON records, so a parse failure is expected noise.
 * The `{` check is only a cheap pre-filter; deliberately no closing-`}` check, since one stray
 * trailing byte would then drop every well-formed record.
 */
export const parseJsonObjectLine = (line: string): Record<string, unknown> | undefined => {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
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
