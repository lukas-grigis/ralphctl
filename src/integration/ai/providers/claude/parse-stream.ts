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

/**
 * Per-spawn token counts pulled from the final `{type:"result"}` event's `usage` object.
 * Every field is optional because cache reads / creations are zero on a stateless spawn and
 * Claude omits the field rather than emitting `0`. Cumulative — already the spawn total at
 * the moment Claude emits the result event, no in-process aggregation needed.
 */
export interface ClaudeUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheCreationTokens?: number;
}

export interface ClaudeEnvelope {
  /** Assistant body — `.result` from the `{type:"result"}` event, or `''` if none arrived. */
  readonly body: string;
  /** Earliest `session_id` seen on any event (init wins under normal operation). */
  readonly sessionId: string | undefined;
  /** Model name from the `system` init event, when present. */
  readonly model: string | undefined;
  /** Token counts from the final `result` event's `usage` object, when present. */
  readonly usage: ClaudeUsage;
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

const numberField = (obj: Record<string, unknown>, ...names: readonly string[]): number | undefined => {
  for (const name of names) {
    const v = obj[name];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

export const createClaudeStreamParser = (): ClaudeStreamParser => {
  let buffer = '';
  // `body` is reassigned from the latest `result` event's `.result` field in `ingest` (one
  // O(1) write), never built by per-line concatenation. Keep it that way — see the analogous
  // `bodyLines.push` + `.join('\n')` pattern in copilot/headless.ts for why.
  let body = '';
  let sessionId: string | undefined;
  let model: string | undefined;
  let usage: ClaudeUsage = {};

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
      // Token usage on the result event: `usage: { input_tokens, output_tokens,
      // cache_read_input_tokens, cache_creation_input_tokens }`. Cumulative — already the
      // spawn total. Stream-json never streams partial counts on intermediate events for `-p`
      // mode, so a single read here is the authoritative figure.
      const u = json['usage'];
      if (isRecord(u)) {
        const i = numberField(u, 'input_tokens', 'inputTokens');
        const o = numberField(u, 'output_tokens', 'outputTokens');
        const cr = numberField(u, 'cache_read_input_tokens', 'cacheReadInputTokens');
        const cc = numberField(u, 'cache_creation_input_tokens', 'cacheCreationInputTokens');
        usage = {
          ...(i !== undefined ? { inputTokens: i } : {}),
          ...(o !== undefined ? { outputTokens: o } : {}),
          ...(cr !== undefined ? { cacheReadTokens: cr } : {}),
          ...(cc !== undefined ? { cacheCreationTokens: cc } : {}),
        };
      }
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
      return { body, sessionId, model, usage };
    },
  };
};
