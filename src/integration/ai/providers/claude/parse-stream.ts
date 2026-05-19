/**
 * Line-oriented parser for `claude -p --verbose --output-format stream-json` (JSONL).
 *
 * The Claude CLI emits one JSON object per line as the session progresses. The shapes we care
 * about (other fields ignored):
 *
 *   {"type":"system","subtype":"init","session_id":"…","model":"claude-…", …}
 *   {"type":"assistant","message":{ … delta … },"session_id":"…"}
 *   {"type":"user","message":{ … tool result … },"session_id":"…"}
 *   {"type":"result","subtype":"success","result":"<assistant text>","session_id":"…", …}
 *
 * The harness pulls the **`result`** event's `.result` string as the authoritative assistant
 * body (the deltas are useful for live-streaming UX, but `result` is what harness-signal parsing
 * runs against today) and the **earliest** `session_id` it sees (typically the `system` init
 * event, which arrives before tokens). `model` is captured from the init event when present.
 *
 * Failure modes are deliberately lenient (matches the Copilot parser shape): non-JSON lines,
 * blank lines, banner / ANSI noise — all skipped silently. A truly empty / malformed stream
 * yields `body=''` and `sessionId=undefined`, so callers' `parseHarnessSignals('')` still runs
 * (and trivially returns no signals) rather than throwing.
 *
 * Replaces the prior single-envelope `--output-format json` parser: stream-json is required so
 * the idle-stdout watchdog at `src/integration/ai/providers/_engine/idle-watchdog.ts` sees
 * progress bytes during long sessions. Plain `json` buffers everything until end-of-session and
 * the watchdog SIGTERMs healthy children mid-task.
 */

export interface ClaudeEnvelope {
  /** Assistant body — `.result` from the `{type:"result"}` event, or `''` if none arrived. */
  readonly body: string;
  /** Earliest `session_id` seen on any event (init wins under normal operation). */
  readonly sessionId: string | undefined;
  /** Model name from the `system` init event, when present. */
  readonly model: string | undefined;
}

export interface ClaudeStreamLine {
  /** Raw line text (no trailing newline). */
  readonly raw: string;
  /** Parsed JSON object when the line was a valid JSON record; absent for non-JSON noise. */
  readonly json?: Record<string, unknown>;
}

export interface ClaudeStreamParser {
  /** Feed a chunk of stdout. Calls `onLine` once per complete newline-terminated line. */
  feed(chunk: string, onLine: (line: ClaudeStreamLine) => void): void;
  /** Flush a trailing partial line if any (called once on child close). */
  flush(onLine: (line: ClaudeStreamLine) => void): void;
  /**
   * Accumulate state from a parsed line. Called by the adapter for every line `feed`/`flush`
   * yields, so the running `{ body, sessionId, model }` snapshot stays internal to the parser
   * and there is one canonical reduction over the stream.
   */
  ingest(line: ClaudeStreamLine): void;
  /** Snapshot the accumulated envelope (body / sessionId / model so far). */
  snapshot(): ClaudeEnvelope;
}

const stringField = (obj: Record<string, unknown>, ...names: readonly string[]): string | undefined => {
  for (const name of names) {
    const v = obj[name];
    if (typeof v === 'string') return v;
  }
  return undefined;
};

export const createClaudeStreamParser = (): ClaudeStreamParser => {
  let buffer = '';
  let body = '';
  let sessionId: string | undefined;
  let model: string | undefined;

  const emit = (raw: string, onLine: (line: ClaudeStreamLine) => void): void => {
    if (raw.length === 0) return;
    if (raw.startsWith('{') && raw.endsWith('}')) {
      try {
        const json = JSON.parse(raw) as Record<string, unknown>;
        onLine({ raw, json });
        return;
      } catch {
        // fall through — non-JSON or malformed: emit as plain text and let `ingest` skip it.
      }
    }
    onLine({ raw });
  };

  const ingest = (line: ClaudeStreamLine): void => {
    const json = line.json;
    if (json === undefined) return;
    // Earliest session_id wins. The system/init event normally arrives first and carries it,
    // but every event after that re-states it; clamping to "first seen" makes the value stable.
    if (sessionId === undefined) {
      const seen = stringField(json, 'session_id', 'sessionId');
      if (seen !== undefined) sessionId = seen;
    }
    const type = stringField(json, 'type');
    if (type === 'system' && model === undefined) {
      const m = stringField(json, 'model');
      if (m !== undefined) model = m;
    }
    if (type === 'result') {
      const r = stringField(json, 'result');
      if (r !== undefined) body = r;
    }
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
    ingest,
    snapshot() {
      return { body, sessionId, model };
    },
  };
};
