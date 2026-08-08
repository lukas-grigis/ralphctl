import type { EventBus } from '@src/business/observability/event-bus.ts';
import { RATE_LIMIT_SCAN_TAIL_CAP } from '@src/integration/ai/providers/_engine/bounded-tail.ts';
import { isRecord, numberField, stringField } from '@src/integration/ai/providers/_engine/json-field.ts';
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
 * Line-split a stdout buffer, dispatching each parsed record to `onMeta` / `onLine`. Returns
 * the residual unterminated tail, which the caller carries into the next chunk.
 */
export const consumeOpencodeLines = (
  buffer: string,
  onMeta: (update: OpencodeMetaUpdate) => void,
  onLine: (obj: Record<string, unknown>) => void
): string => {
  let remaining = buffer;
  while (true) {
    const nl = remaining.indexOf('\n');
    if (nl === -1) return remaining;
    const line = remaining.slice(0, nl);
    remaining = remaining.slice(nl + 1);
    const obj = parseOpencodeJsonLine(line);
    if (obj === undefined) continue;
    onLine(obj);
    const update = extractOpencodeMetaUpdate(obj);
    if (update !== undefined) onMeta(update);
  }
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
  let lineBuf = '';

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
    const text = assistantText(obj);
    if (text === undefined) return;
    body = `${body}${body.length > 0 ? '\n' : ''}${text}`;
    assistantTail = `${assistantTail}${assistantTail.length > 0 ? '\n' : ''}${text}`.slice(-RATE_LIMIT_SCAN_TAIL_CAP);
  };

  return {
    consumeChunk: (chunk) => {
      lineBuf = consumeOpencodeLines(lineBuf + chunk, onMeta, onLine);
    },
    flush: () => {
      if (lineBuf.length > 0) {
        lineBuf = consumeOpencodeLines(lineBuf + '\n', onMeta, onLine);
      }
    },
    getSessionId: () => sessionId,
    getInputTokens: () => inputTokens,
    getOutputTokens: () => outputTokens,
    getBody: () => body,
    getStdoutTail: () => (assistantTail.length > 0 ? assistantTail : undefined),
  };
};
