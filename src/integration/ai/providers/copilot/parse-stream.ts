/**
 * Line-oriented parser for `copilot --output-format json` (JSONL). Mirrors the shape of
 * `parse-claude-stream.ts` so the Copilot adapter can drive the same accumulation pattern.
 *
 * The Copilot CLI emits one JSON object per line; non-JSON lines (rare; usually banner /
 * status) pass through as raw text. Tools are not consuming the structured events at the
 * moment — the adapter just accumulates plain-text lines into the response body.
 */

export interface CopilotStreamLine {
  /** Raw line text (no trailing newline). */
  readonly raw: string;
  /** Parsed JSON object when the line was a valid JSON record; absent for plain lines. */
  readonly json?: Record<string, unknown>;
  /** Convenience: `json.session_id` (or `json.sessionId`) when present, for the adapter to log. */
  readonly sessionId?: string;
}

export interface CopilotStreamParser {
  /** Feed a chunk of stdout. Calls `onLine` once per complete line. */
  feed(chunk: string, onLine: (line: CopilotStreamLine) => void): void;
  /** Flush a trailing partial line if any (called once on child exit). */
  flush(onLine: (line: CopilotStreamLine) => void): void;
}

export const createCopilotStreamParser = (): CopilotStreamParser => {
  let buffer = '';
  const emit = (raw: string, onLine: (line: CopilotStreamLine) => void): void => {
    if (raw.length === 0) return;
    if (raw.startsWith('{') && raw.endsWith('}')) {
      try {
        const json = JSON.parse(raw) as Record<string, unknown>;
        const sessionId =
          typeof json['session_id'] === 'string'
            ? (json['session_id'] as string)
            : typeof json['sessionId'] === 'string'
              ? (json['sessionId'] as string)
              : undefined;
        onLine(sessionId !== undefined ? { raw, json, sessionId } : { raw, json });
        return;
      } catch {
        // fall through — emit as plain text
      }
    }
    onLine({ raw });
  };
  return {
    feed(chunk, onLine) {
      buffer += chunk;
      let nl = buffer.indexOf('\n');
      while (nl !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        emit(line, onLine);
        nl = buffer.indexOf('\n');
      }
    },
    flush(onLine) {
      if (buffer.length > 0) {
        emit(buffer, onLine);
        buffer = '';
      }
    },
  };
};
