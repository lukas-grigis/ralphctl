/**
 * Line-oriented parser for `copilot --output-format json` (JSONL). Mirrors the shape of
 * `parse-claude-stream.ts` so the Copilot adapter can drive the same accumulation pattern.
 *
 * The Copilot CLI emits one JSON object per line; non-JSON lines (rare; usually banner /
 * status) pass through as raw text. We parse metadata (session/model/usage) and conservatively
 * extract assistant body text from known event shapes.
 *
 * Port-shaped types (`CopilotStreamLine`, `CopilotStreamParser`, `CopilotUsage`) live in
 * `_engine/copilot-stream.ts`; this file holds the factory only.
 */

import type {
  CopilotStreamLine,
  CopilotStreamParser,
  CopilotUsage,
} from '@src/integration/ai/providers/_engine/copilot-stream.ts';
import { STDOUT_LINE_PARSE_CAP } from '@src/integration/ai/providers/_engine/bounded-tail.ts';
import { isRecord, numberField, stringField } from '@src/integration/ai/providers/_engine/json-field.ts';

const extractUsage = (json: Record<string, unknown>): CopilotUsage | undefined => {
  // Two shapes seen in the wild across CLI versions: top-level `input_tokens` / `output_tokens`,
  // or nested under a `usage` object. Try both; honest about reporting only what is present.
  const ti = numberField(json, 'input_tokens', 'inputTokens', 'prompt_tokens');
  const to = numberField(json, 'output_tokens', 'outputTokens', 'completion_tokens');
  if (ti !== undefined || to !== undefined) {
    return {
      ...(ti !== undefined ? { inputTokens: ti } : {}),
      ...(to !== undefined ? { outputTokens: to } : {}),
    };
  }
  const u = json['usage'];
  if (!isRecord(u)) return undefined;
  const ni = numberField(u, 'input_tokens', 'inputTokens', 'prompt_tokens');
  const no = numberField(u, 'output_tokens', 'outputTokens', 'completion_tokens');
  if (ni === undefined && no === undefined) return undefined;
  return {
    ...(ni !== undefined ? { inputTokens: ni } : {}),
    ...(no !== undefined ? { outputTokens: no } : {}),
  };
};

/**
 * Conservative best-effort extraction of assistant-emitted text from a single Copilot JSONL
 * event. Recognised shapes today:
 *
 *   - `{ type: 'assistant.message_delta', data: { deltaContent: string } }` — observed Copilot CLI
 *   - `{ type: 'assistant.message',       data: { content: string } }`      — observed Copilot CLI
 *   - `{ type: 'response.output_text.delta', delta: string }`               — OpenAI Responses API
 *   - `{ type: 'content_block_delta',     delta: { text: string } }`        — Anthropic SSE protocol
 *   - `{ type: 'message',                 content: string }`                — generic shape
 *
 * A "fall back on any top-level `content`/`text` string" branch was considered and rejected —
 * tool-call payloads and debug-echo events sometimes carry those keys without being assistant
 * body, so blindly accepting them would corrupt signal parsing. Every branch above matches its
 * protocol's `type` discriminator AND structure precisely; we never blindly stringify unknown
 * JSON. Returns `undefined` when no branch matches; the adapter then pushes the raw line into
 * the body buffer so nothing is silently dropped from the forensic body.txt capture.
 *
 * Until we capture a real `copilot --output-format=json` stream, the speculative branches are
 * inert (no Copilot release emits them today). Their value is the forensic safety net + a
 * cheap typecheck-friendly broadening when we do see them.
 */
const extractBodyText = (json: Record<string, unknown>): string | undefined => {
  const eventType = stringField(json, 'type');
  const data = json['data'];

  // 1. Copilot CLI v1 assistant delta — `{ type, data: { deltaContent } }`
  if (eventType === 'assistant.message_delta' && isRecord(data)) {
    return stringField(data, 'deltaContent');
  }
  // 2. Copilot CLI v1 assistant final — `{ type, data: { content } }`
  if (eventType === 'assistant.message' && isRecord(data)) {
    return stringField(data, 'content');
  }
  // 3. OpenAI Responses API — `{ type: 'response.output_text.delta', delta: '<text>' }`
  if (eventType === 'response.output_text.delta') {
    return stringField(json, 'delta');
  }
  // 4. Anthropic streaming SSE — `{ type: 'content_block_delta', delta: { text: '<text>' } }`
  if (eventType === 'content_block_delta') {
    const delta = json['delta'];
    if (isRecord(delta)) return stringField(delta, 'text');
  }
  // 5. Generic message envelope — `{ type: 'message', content: '<text>' }`
  if (eventType === 'message') {
    const c = stringField(json, 'content');
    if (c !== undefined) return c;
  }
  return undefined;
};

export const createCopilotStreamParser = (): CopilotStreamParser => {
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
          `[copilot-stream] in-flight NDJSON line exceeded ${String(STDOUT_LINE_PARSE_CAP)} bytes — ` +
            'truncating the parse buffer to its tail and continuing. A single record is streaming an ' +
            'oversized tool result; the affected line may parse as plain text.'
        );
      }
    }
  };
  const emit = (raw: string, onLine: (line: CopilotStreamLine) => void): void => {
    if (raw.length === 0) return;
    if (raw.startsWith('{') && raw.endsWith('}')) {
      try {
        // Why: stdout-stream records arrive at high volume — extractors below
        // (`stringField`, `extractUsage`, `extractBodyText`) narrowly type-check
        // every field they consume; unknown keys are ignored.
        const json = JSON.parse(raw) as Record<string, unknown>;
        const sessionId = stringField(json, 'session_id', 'sessionId');
        const model = stringField(json, 'model');
        const usage = extractUsage(json);
        const bodyText = extractBodyText(json);
        const line: CopilotStreamLine = {
          raw,
          json,
          ...(sessionId !== undefined ? { sessionId } : {}),
          ...(model !== undefined ? { model } : {}),
          ...(usage !== undefined ? { usage } : {}),
          ...(bodyText !== undefined ? { bodyText } : {}),
        };
        onLine(line);
        return;
      } catch {
        // fall through — emit as plain text
      }
    }
    onLine({ raw });
  };
  return {
    feed(chunk, onLine) {
      appendCapped(chunk);
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
