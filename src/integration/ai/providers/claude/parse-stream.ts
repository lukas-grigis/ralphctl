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
 * yields `body=''` and `sessionId=undefined`, so callers receive a well-shaped envelope even on
 * truly empty input rather than throwing.
 *
 * Port-shaped types (`ClaudeStreamLine`, `ClaudeStreamParser`, `ClaudeEnvelope`, `ClaudeUsage`)
 * live in `_engine/claude-stream.ts`; this file holds the factory only.
 */

import type {
  ClaudeLiveUsage,
  ClaudeStreamLine,
  ClaudeStreamParser,
  ClaudeUsage,
} from '@src/integration/ai/providers/_engine/claude-stream.ts';
import { STDOUT_LINE_PARSE_CAP } from '@src/integration/ai/providers/_engine/bounded-tail.ts';
import { isRecord, numberField, stringField } from '@src/integration/ai/providers/_engine/json-field.ts';

// Module-level (no closure over parser state) — safe to hoist out of the factory.
//
// Why: stdout-stream records arrive at high volume — a Zod schema per record is overkill.
// `ingest()` downstream extracts known fields with narrow `stringField` / `numberField` helpers;
// unknown keys are ignored.
const emitLine = (raw: string, onLine: (line: ClaudeStreamLine) => void): void => {
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

// Per-turn usage lives on `message.usage` (same nested field names the result path uses).
const extractLiveUsage = (u: Record<string, unknown>): ClaudeLiveUsage => {
  const i = numberField(u, 'input_tokens', 'inputTokens');
  const cr = numberField(u, 'cache_read_input_tokens', 'cacheReadInputTokens');
  const cc = numberField(u, 'cache_creation_input_tokens', 'cacheCreationInputTokens');
  return {
    ...(i !== undefined ? { inputTokens: i } : {}),
    ...(cr !== undefined ? { cacheReadTokens: cr } : {}),
    ...(cc !== undefined ? { cacheCreationTokens: cc } : {}),
  };
};

// Token usage on the result event: `usage: { input_tokens, output_tokens,
// cache_read_input_tokens, cache_creation_input_tokens }`. Cumulative — already the spawn
// total. Stream-json never streams partial counts on intermediate events for `-p` mode, so a
// single read here is the authoritative figure.
const extractResultUsage = (u: Record<string, unknown>): ClaudeUsage => {
  const i = numberField(u, 'input_tokens', 'inputTokens');
  const o = numberField(u, 'output_tokens', 'outputTokens');
  const cr = numberField(u, 'cache_read_input_tokens', 'cacheReadInputTokens');
  const cc = numberField(u, 'cache_creation_input_tokens', 'cacheCreationInputTokens');
  return {
    ...(i !== undefined ? { inputTokens: i } : {}),
    ...(o !== undefined ? { outputTokens: o } : {}),
    ...(cr !== undefined ? { cacheReadTokens: cr } : {}),
    ...(cc !== undefined ? { cacheCreationTokens: cc } : {}),
  };
};

export const createClaudeStreamParser = (): ClaudeStreamParser => {
  let buffer = '';
  // One-shot latch: warn exactly once per parser so a child that streams a pathologically long
  // unterminated line does not itself spam the console with one warning per chunk.
  let overflowWarned = false;
  // Cap the in-flight line accumulator. A single NDJSON record embedding a large file-read /
  // bash tool result can grow `buffer` to tens of MB before its newline clears it — an OOM-class
  // accumulation. `feed` is the SOLE append site, so capping here keeps the invariant for `flush`
  // too (it only drains an already-bounded buffer). Drop the OLDEST bytes (keep the tail) so the
  // record's terminating `}`/newline, when it finally arrives, still lands inside the window.
  const appendCapped = (chunk: string): void => {
    buffer += chunk;
    if (buffer.length > STDOUT_LINE_PARSE_CAP) {
      buffer = buffer.slice(-STDOUT_LINE_PARSE_CAP);
      if (!overflowWarned) {
        overflowWarned = true;
        console.warn(
          `[claude-stream] in-flight NDJSON line exceeded ${String(STDOUT_LINE_PARSE_CAP)} bytes — ` +
            'truncating the parse buffer to its tail and continuing. A single record is streaming an ' +
            'oversized tool result; the affected line will be emitted as a raw (unparsed) text line.'
        );
      }
    }
  };
  // `body` is reassigned from the latest `result` event's `.result` field in `ingest` (one
  // O(1) write), never built by per-line concatenation. Keep it that way — see the analogous
  // `bodyLines.push` + `.join('\n')` pattern in copilot/headless.ts for why.
  let body = '';
  let sessionId: string | undefined;
  let model: string | undefined;
  let usage: ClaudeUsage = {};
  // Per-turn (live) usage: latest-wins from each `assistant` event's `message.usage`. The LAST
  // assistant turn's input + cacheRead + cacheCreation IS the current context-window occupancy,
  // unlike the cumulative `result.usage` above. Stays `{}` if no assistant carried usage.
  let liveUsage: ClaudeLiveUsage = {};

  // Earliest session_id wins. The system/init event normally arrives first and carries it, but
  // every event after that re-states it; clamping to "first seen" makes the value stable.
  const applySessionId = (json: Record<string, unknown>): void => {
    if (sessionId !== undefined) return;
    const seen = stringField(json, 'session_id', 'sessionId');
    if (seen !== undefined) sessionId = seen;
  };

  const applyModel = (type: string | undefined, json: Record<string, unknown>): void => {
    if (type !== 'system' || model !== undefined) return;
    const m = stringField(json, 'model');
    if (m !== undefined) model = m;
  };

  // Defensive: content-only assistant deltas carry no usage — only update when a usage record
  // is present, so a usage-less delta never clobbers a captured live snapshot.
  const applyLiveUsage = (type: string | undefined, json: Record<string, unknown>): void => {
    if (type !== 'assistant') return;
    const message = json['message'];
    if (!isRecord(message)) return;
    const u = message['usage'];
    if (isRecord(u)) liveUsage = extractLiveUsage(u);
  };

  const applyResultFields = (type: string | undefined, json: Record<string, unknown>): void => {
    if (type !== 'result') return;
    const r = stringField(json, 'result');
    if (r !== undefined) body = r;
    const u = json['usage'];
    if (isRecord(u)) usage = extractResultUsage(u);
  };

  const ingest = (line: ClaudeStreamLine): void => {
    const json = line.json;
    if (json === undefined) return;
    applySessionId(json);
    const type = stringField(json, 'type');
    applyModel(type, json);
    applyLiveUsage(type, json);
    applyResultFields(type, json);
  };

  return {
    feed(chunk, onLine) {
      appendCapped(chunk);
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
    ingest,
    snapshot() {
      return { body, sessionId, model, usage, liveUsage };
    },
  };
};
