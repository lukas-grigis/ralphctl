import type { EventBus } from '@src/business/observability/event-bus.ts';
import {
  FORENSIC_BODY_TAIL_CAP,
  RATE_LIMIT_SCAN_TAIL_CAP,
} from '@src/integration/ai/providers/_engine/bounded-tail.ts';
import { isRecord, numberField, stringField } from '@src/integration/ai/providers/_engine/json-field.ts';
import { createCappedLineFeed } from '@src/integration/ai/providers/_engine/line-feed.ts';
import {
  publishAssistantEvent,
  publishToolResultEvent,
  publishToolUseEvent,
} from '@src/integration/ai/providers/_engine/stream-debug-events.ts';

/**
 * Parser for OpenCode's `run --format json` stream (opencode-ai v1.18.15).
 *
 * The stream is JSONL. Every record is `{ type, timestamp, sessionID, part }`, where `part`
 * carries the payload and repeats `sessionID` / `messageID`. Observed record types:
 *
 *   - `step_start`  — a turn (or tool round-trip) begins. No payload we surface.
 *   - `text`        — assistant prose. `part.text` is the body chunk.
 *   - `tool_use`    — a tool call, already RESOLVED: `part.state` carries `status`, `input`
 *                     and `output` together. Unlike Claude / Codex there is no separate
 *                     result record, so one `tool_use` record fans out to BOTH a `tool_use`
 *                     and a `tool_result` debug event.
 *   - `step_finish` — end of a step. `part.reason` is `stop` | `tool-calls`; `part.tokens`
 *                     carries `{ total, input, output, reasoning, cache: { read, write } }`.
 *   - `error`       — a fatal CLI error, e.g. an unreachable model id. Shaped
 *                     `{ error: { name, data: { message } } }` and NOT accompanied by anything on
 *                     stderr, so it folds into the body / tail (see `streamErrorText`).
 *
 * Two shape details that differ from the sibling adapters and drive the accumulator rules:
 *
 *   1. `sessionID` appears on EVERY record, not on a leading init frame. First one wins; there
 *      is no ordering dependency and no "the id never arrived" failure mode short of an empty
 *      stream.
 *   2. `part.tokens.total` is CUMULATIVE across the session while `input` / `output` are
 *      per-step. Summing `total` would multiply-count, and last-write-wins on `input` /
 *      `output` would report only the final step. Usage is therefore SUMMED over the per-step
 *      `input` / `output` fields, which is the only combination that yields a turn total.
 *
 * Schema-tolerant throughout: unknown record types and malformed lines are skipped silently,
 * matching the sibling parsers.
 */

const PROVIDER_NAME = 'opencode-provider';

/** Fields the tracker pulls out of one already-parsed stdout record. */
export interface OpencodeMetaUpdate {
  readonly sessionId?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

/**
 * Trim + JSON.parse one stdout line. Returns `undefined` for blank lines, lines that do not
 * look like JSON, and lines that fail to parse — OpenCode interleaves plain-text diagnostics
 * (and ANSI-coloured error banners) with the JSON records, so a parse miss is expected rather
 * than exceptional.
 */
export const parseOpencodeJsonLine = (line: string): Record<string, unknown> | undefined => {
  const trimmed = line.trim();
  if (trimmed.length === 0 || !trimmed.startsWith('{')) return undefined;
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return undefined;
  }
};

/** `part` sub-object of a record, when present and shaped as an object. */
const partOf = (obj: Record<string, unknown>): Record<string, unknown> | undefined => {
  const part = obj['part'];
  return isRecord(part) ? part : undefined;
};

/**
 * Pull session id + per-step token usage out of one record. `sessionID` is read from the record
 * root first and the `part` second — both carry it, and preferring the root keeps the read
 * working if a future build drops the duplicate.
 */
export const extractOpencodeMetaUpdate = (obj: Record<string, unknown>): OpencodeMetaUpdate | undefined => {
  const part = partOf(obj);
  const id =
    stringField(obj, 'sessionID', 'sessionId') ?? (part !== undefined ? stringField(part, 'sessionID') : undefined);
  const tokensObj = part?.['tokens'];
  const tokens = isRecord(tokensObj) ? tokensObj : undefined;
  const i = tokens !== undefined ? numberField(tokens, 'input') : undefined;
  const o = tokens !== undefined ? numberField(tokens, 'output') : undefined;
  if (id === undefined && i === undefined && o === undefined) return undefined;
  return {
    ...(id !== undefined ? { sessionId: id } : {}),
    ...(i !== undefined ? { inputTokens: i } : {}),
    ...(o !== undefined ? { outputTokens: o } : {}),
  };
};

/** Assistant prose for a `text` record — also the body source and rate-limit haystack. */
export const assistantText = (obj: Record<string, unknown>): string | undefined => {
  if (stringField(obj, 'type') !== 'text') return undefined;
  const part = partOf(obj);
  return part !== undefined ? stringField(part, 'text') : undefined;
};

/**
 * Diagnostic text for an `error` record: `{"type":"error","error":{"name":"UnknownError",
 * "data":{"message":"…"}}}`. An unreachable model id makes `opencode run` exit 1 with an EMPTY
 * stderr and puts its only explanation on this record, so folding it into the body / tail is what
 * keeps the `ProcessCrashError` message from reading `process exited with code 1: ` and nothing
 * else.
 */
const streamErrorText = (obj: Record<string, unknown>): string | undefined => {
  if (stringField(obj, 'type') !== 'error') return undefined;
  const errObj = obj['error'];
  const err = isRecord(errObj) ? errObj : undefined;
  if (err === undefined) return undefined;
  const dataObj = err['data'];
  const data = isRecord(dataObj) ? dataObj : undefined;
  const parts = [stringField(err, 'name'), data !== undefined ? stringField(data, 'message') : undefined].filter(
    (p): p is string => p !== undefined && p.length > 0
  );
  return parts.length > 0 ? parts.join(': ') : undefined;
};

const safeJson = (v: unknown): string | undefined => {
  if (v === undefined || v === null) return undefined;
  try {
    const s = JSON.stringify(v);
    return s === '{}' || s === '[]' ? undefined : s;
  } catch {
    return undefined;
  }
};

/**
 * One resolved `tool_use` record → a `tool_use` event plus the matching `tool_result` event.
 * OpenCode resolves calls in place, so emitting only `tool_use` would leave every tool call
 * looking unfinished in the debug trace.
 */
const publishToolEvents = (eventBus: EventBus, part: Record<string, unknown>): void => {
  const tool = stringField(part, 'tool') ?? stringField(part, 'callID') ?? '';
  const stateObj = part['state'];
  const state = isRecord(stateObj) ? stateObj : undefined;
  publishToolUseEvent(eventBus, PROVIDER_NAME, tool, safeJson(state?.['input']));
  if (state === undefined) return;
  const status = stringField(state, 'status');
  // OpenCode reports `completed` on success; anything else (`error`, or an absent status on a
  // truncated record) is surfaced as an error so a failed tool call is visible in the trace.
  publishToolResultEvent(
    eventBus,
    PROVIDER_NAME,
    tool,
    status === 'completed' ? 'ok' : 'error',
    stringField(state, 'output')
  );
};

/** Emit debug events for one record. Unknown types intentionally produce nothing. */
export const publishOpencodeStreamLineEvents = (eventBus: EventBus, obj: Record<string, unknown>): void => {
  const type = stringField(obj, 'type');
  if (type === 'text') {
    publishAssistantEvent(eventBus, PROVIDER_NAME, assistantText(obj));
    return;
  }
  if (type !== 'tool_use') return;
  const part = partOf(obj);
  if (part !== undefined) publishToolEvents(eventBus, part);
};

/**
 * Per-line emitter handed to {@link createCappedLineFeed}. Module-level (closes over no tracker
 * state) — unparseable lines simply emit nothing, matching the sibling parsers.
 */
const emitOpencodeLine = (raw: string, onLine: (obj: Record<string, unknown>) => void): void => {
  const obj = parseOpencodeJsonLine(raw);
  if (obj !== undefined) onLine(obj);
};

/**
 * Mutable per-attempt accumulator over the JSONL stream. One fresh instance per `attempt()`
 * call, mirroring the sibling adapters' trackers.
 *
 * Unlike codex, OpenCode has no `-o <tempfile>` forensic sink — the assistant body exists only
 * on the stream — so this tracker is also the body source via {@link getBody}.
 */
export interface OpencodeAttemptTracker {
  readonly consumeChunk: (chunk: string) => void;
  /** Flush a partial trailing line once the child exits without a final newline. */
  readonly flush: () => void;
  readonly getSessionId: () => string | undefined;
  readonly getInputTokens: () => number | undefined;
  readonly getOutputTokens: () => number | undefined;
  /** Full accumulated assistant prose — the audit-[09] forensic body. */
  readonly getBody: () => string;
  /** Bounded assistant tail used as the rate-limit classifier's haystack. */
  readonly getStdoutTail: () => string | undefined;
}

export const createOpencodeAttemptTracker = (eventBus: EventBus): OpencodeAttemptTracker => {
  let sessionId: string | undefined;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let body = '';
  let assistantTail = '';
  const lineFeed = createCappedLineFeed<Record<string, unknown>>('opencode-stream', emitOpencodeLine);

  const onMeta = (update: OpencodeMetaUpdate): void => {
    if (update.sessionId !== undefined && sessionId === undefined) sessionId = update.sessionId;
    // SUM, not last-wins: `input` / `output` are per-step (see the module comment). A turn that
    // makes three tool round-trips emits three step_finish records and the caller wants the
    // total, so each step's figures accumulate.
    if (update.inputTokens !== undefined) inputTokens = (inputTokens ?? 0) + update.inputTokens;
    if (update.outputTokens !== undefined) outputTokens = (outputTokens ?? 0) + update.outputTokens;
  };

  const onLine = (obj: Record<string, unknown>): void => {
    publishOpencodeStreamLineEvents(eventBus, obj);
    // `error` records fold in alongside assistant prose: they are the CLI's only explanation for
    // an exit-1 with empty stderr (see `streamErrorText`).
    const text = assistantText(obj) ?? streamErrorText(obj);
    if (text === undefined) return;
    // Both accumulators are capped — an hours-long chatty session must not grow either without
    // bound (same OOM class the line-parse cap guards).
    body = `${body}${body.length > 0 ? '\n' : ''}${text}`.slice(-FORENSIC_BODY_TAIL_CAP);
    assistantTail = `${assistantTail}${assistantTail.length > 0 ? '\n' : ''}${text}`.slice(-RATE_LIMIT_SCAN_TAIL_CAP);
  };

  // Ordering is load-bearing: `onLine` (debug events + body) runs before `onMeta` (session id +
  // usage), matching the pre-shared-feed dispatch order.
  const dispatch = (obj: Record<string, unknown>): void => {
    onLine(obj);
    const update = extractOpencodeMetaUpdate(obj);
    if (update !== undefined) onMeta(update);
  };

  return {
    consumeChunk: (chunk) => {
      lineFeed.feed(chunk, dispatch);
    },
    flush: () => {
      lineFeed.flush(dispatch);
    },
    getSessionId: () => sessionId,
    getInputTokens: () => inputTokens,
    getOutputTokens: () => outputTokens,
    getBody: () => body,
    getStdoutTail: () => (assistantTail.length > 0 ? assistantTail : undefined),
  };
};
