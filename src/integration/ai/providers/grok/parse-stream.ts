import type { EventBus } from '@src/business/observability/event-bus.ts';
import {
  FORENSIC_BODY_TAIL_CAP,
  RATE_LIMIT_SCAN_TAIL_CAP,
  createBoundedTail,
} from '@src/integration/ai/providers/_engine/bounded-tail.ts';
import { numberField, recordField, stringField } from '@src/integration/ai/providers/_engine/json-field.ts';
import type { ProviderTokenUsage } from '@src/integration/ai/providers/_engine/run-provider-attempt.ts';
import { createCappedLineFeed, emitJsonObjectLine } from '@src/integration/ai/providers/_engine/line-feed.ts';
import {
  publishAssistantEvent,
  publishToolResultEvent,
  publishCliErrorEvent,
  publishToolUseEvent,
  previewJson,
} from '@src/integration/ai/providers/_engine/stream-debug-events.ts';

/**
 * Parser for Grok Build CLI `--output-format streaming-json`.
 *
 * Record types and event semantics verified against Grok Build CLI 1.0.30's shipped CLI reference
 * on 2026-09-15; minimum supported version is 1.0.13.
 *
 * NDJSON. Switch on `type`. Observed record types:
 *
 *   - `text`                 — assistant body chunk; concatenate `data`
 *   - `thought`              — skip for body
 *   - `tool_call`            — tool_use debug (`toolName` + `rawInput`)
 *   - `tool_call_update`     — tool_result debug (`status` + `rawOutput`)
 *   - `usage`                — per-response token counters; accumulate
 *   - `end`                  — turn aggregate: `sessionId` (first wins) + authoritative usage
 *   - `error`                — CLI error message
 *   - `available_commands`   — skip
 *
 * Schema-tolerant throughout: non-JSON, blank, and unknown types are skipped. Never throws.
 */

const PROVIDER_NAME = 'grok-provider';

export interface GrokMetaUpdate {
  readonly sessionId?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheCreationTokens?: number;
}

const usageUpdate = (usage: Record<string, unknown>): Omit<GrokMetaUpdate, 'sessionId'> => {
  const inputTokens = numberField(usage, 'input_tokens');
  const outputTokens = numberField(usage, 'output_tokens');
  const cacheReadTokens = numberField(usage, 'cache_read_input_tokens');
  const cacheCreationTokens = numberField(usage, 'cache_creation_input_tokens');
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
  };
};

/** Only an `end` that actually ships `usage` replaces the running totals (see `onMeta`). */
const carriesTurnUsage = (obj: Record<string, unknown>): boolean =>
  stringField(obj, 'type') === 'end' && recordField(obj, 'usage') !== undefined;

export const extractGrokMetaUpdate = (obj: Record<string, unknown>): GrokMetaUpdate | undefined => {
  const type = stringField(obj, 'type');
  const sessionId = stringField(obj, 'sessionId');
  const usage = type === 'usage' || type === 'end' ? recordField(obj, 'usage') : undefined;
  const fromUsage = usage !== undefined ? usageUpdate(usage) : {};
  if (sessionId === undefined && Object.keys(fromUsage).length === 0) return undefined;
  return {
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...fromUsage,
  };
};

export const assistantText = (obj: Record<string, unknown>): string | undefined => {
  if (stringField(obj, 'type') !== 'text') return undefined;
  return stringField(obj, 'data');
};

const streamErrorText = (obj: Record<string, unknown>): string | undefined => {
  if (stringField(obj, 'type') !== 'error') return undefined;
  return stringField(obj, 'message');
};

export const publishGrokStreamLineEvents = (
  eventBus: EventBus,
  obj: Record<string, unknown>,
  toolNames: Map<string, string>
): void => {
  const type = stringField(obj, 'type');
  if (type === 'text') {
    publishAssistantEvent(eventBus, PROVIDER_NAME, assistantText(obj));
    return;
  }
  if (type === 'error') {
    const text = streamErrorText(obj);
    if (text !== undefined) publishCliErrorEvent(eventBus, PROVIDER_NAME, text);
    return;
  }
  if (type === 'tool_call') {
    const tool = stringField(obj, 'toolName') ?? 'unknown';
    const id = stringField(obj, 'toolCallId');
    if (id !== undefined) toolNames.set(id, tool);
    publishToolUseEvent(eventBus, PROVIDER_NAME, tool, previewJson(obj['rawInput']));
    return;
  }
  if (type !== 'tool_call_update') return;
  const status = stringField(obj, 'status');
  // Intermediate progress is not a result — mapping it to error painted a false tool failure
  // on the debug rail before the terminal `completed` / `failed` update arrived.
  if (status === 'in_progress' || status === 'running') return;
  // Fail-visible like the opencode sibling: `completed` is the only success status; anything
  // else (a known `failed`/`error`, or an absent status on a truncated record) surfaces as an
  // error so a failed tool call is never invisible in the trace.
  const id = stringField(obj, 'toolCallId');
  const tool = (id !== undefined ? toolNames.get(id) : undefined) ?? 'unknown';
  // Terminal update — drop the name so the map only ever holds in-flight calls.
  if (id !== undefined) toolNames.delete(id);
  publishToolResultEvent(
    eventBus,
    PROVIDER_NAME,
    tool,
    status === 'completed' ? 'ok' : 'error',
    previewJson(obj['rawOutput'])
  );
};

export interface GrokAttemptTracker {
  readonly consumeChunk: (chunk: string) => void;
  readonly flush: () => void;
  readonly getSessionId: () => string | undefined;
  readonly getUsage: () => ProviderTokenUsage;
  readonly getBody: () => string;
  readonly getStdoutTail: () => string | undefined;
  readonly getStreamError: () => string | undefined;
}

export const createGrokAttemptTracker = (eventBus: EventBus): GrokAttemptTracker => {
  let sessionId: string | undefined;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let cacheReadTokens: number | undefined;
  let cacheCreationTokens: number | undefined;
  // The rate-limit tail is this body's last bytes, so one accumulator serves both.
  const body = createBoundedTail(FORENSIC_BODY_TAIL_CAP);
  let streamError: string | undefined;
  const toolNames = new Map<string, string>();
  const lineFeed = createCappedLineFeed<Record<string, unknown>>('grok-stream', emitJsonObjectLine);

  const addTokens = (current: number | undefined, next: number | undefined): number | undefined => {
    if (next === undefined) return current;
    if (current === undefined) return next;
    return current + next;
  };

  /**
   * `usage` records are per model response and accumulate; an `end` carrying usage is the turn
   * aggregate and replaces the totals. The replace is per RECORD, not per field: a partial `end`
   * drops the counters it omits rather than mixing two accounting bases in one ledger row. An
   * `end` without usage leaves the accumulated totals standing.
   */
  const onMeta = (update: GrokMetaUpdate, replacesTotals: boolean): void => {
    if (update.sessionId !== undefined && sessionId === undefined) sessionId = update.sessionId;
    if (replacesTotals) {
      inputTokens = update.inputTokens;
      outputTokens = update.outputTokens;
      cacheReadTokens = update.cacheReadTokens;
      cacheCreationTokens = update.cacheCreationTokens;
      return;
    }
    inputTokens = addTokens(inputTokens, update.inputTokens);
    outputTokens = addTokens(outputTokens, update.outputTokens);
    cacheReadTokens = addTokens(cacheReadTokens, update.cacheReadTokens);
    cacheCreationTokens = addTokens(cacheCreationTokens, update.cacheCreationTokens);
  };

  const onLine = (obj: Record<string, unknown>): void => {
    publishGrokStreamLineEvents(eventBus, obj, toolNames);
    const errorText = streamErrorText(obj);
    if (errorText !== undefined) streamError = errorText;
    const text = assistantText(obj);
    if (text !== undefined) body.append(text);
  };

  const dispatch = (obj: Record<string, unknown>): void => {
    onLine(obj);
    // A priced `end` reaches `onMeta` even when `extractGrokMetaUpdate` found nothing in it (a
    // `usage: {}` with no sessionId), so the record-level replace still clears the per-response
    // basis rather than silently leaving it standing.
    const replacesTotals = carriesTurnUsage(obj);
    const update = extractGrokMetaUpdate(obj);
    if (update === undefined && !replacesTotals) return;
    onMeta(update ?? {}, replacesTotals);
  };

  return {
    consumeChunk: (chunk) => {
      lineFeed.feed(chunk, dispatch);
    },
    flush: () => {
      lineFeed.flush(dispatch);
    },
    getSessionId: () => sessionId,
    getUsage: () => ({
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
      ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
    }),
    getBody: body.value,
    getStdoutTail: () => body.value().slice(-RATE_LIMIT_SCAN_TAIL_CAP) || undefined,
    getStreamError: () => streamError,
  };
};
