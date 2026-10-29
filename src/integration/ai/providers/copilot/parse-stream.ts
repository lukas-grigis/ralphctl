/**
 * Line-oriented parser for `copilot --output-format json` (JSONL). JSON records yield session id,
 * model, usage and — for known event shapes only — assistant body text; non-JSON lines (banner /
 * status) pass through raw.
 */

import type {
  CopilotStreamLine,
  CopilotStreamParser,
  CopilotUsage,
} from '@src/integration/ai/providers/_engine/copilot-stream.ts';
import { createCappedLineFeed, parseJsonObjectLine } from '@src/integration/ai/providers/_engine/line-feed.ts';
import { numberField, recordField, stringField } from '@src/integration/ai/providers/_engine/json-field.ts';

// CLI versions report counts either top-level or nested under `usage`; the top level wins.
const extractUsage = (json: Record<string, unknown>): CopilotUsage | undefined => {
  for (const src of [json, recordField(json, 'usage')]) {
    const inputTokens = numberField(src, 'input_tokens', 'inputTokens', 'prompt_tokens');
    const outputTokens = numberField(src, 'output_tokens', 'outputTokens', 'completion_tokens');
    if (inputTokens !== undefined || outputTokens !== undefined) {
      return {
        ...(inputTokens !== undefined ? { inputTokens } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {}),
      };
    }
  }
  return undefined;
};

/**
 * Assistant text from a known event shape: Copilot CLI `assistant.message_delta` /
 * `assistant.message` (observed), plus the OpenAI Responses `response.output_text.delta`, Anthropic
 * SSE `content_block_delta` and a generic `message` (speculative; no release emits them yet). Each
 * branch matches its `type` AND structure — never a blind top-level `content` / `text`, which
 * tool-call and echo events also carry and which would corrupt signal parsing.
 */
const extractBodyText = (json: Record<string, unknown>): string | undefined => {
  const data = recordField(json, 'data');
  switch (stringField(json, 'type')) {
    case 'assistant.message_delta':
      return stringField(data, 'deltaContent');
    case 'assistant.message':
      return stringField(data, 'content');
    case 'response.output_text.delta':
      return stringField(json, 'delta');
    case 'content_block_delta':
      return stringField(recordField(json, 'delta'), 'text');
    case 'message':
      return stringField(json, 'content');
    default:
      return undefined;
  }
};

const emitLine = (raw: string, onLine: (line: CopilotStreamLine) => void): void => {
  if (raw.length === 0) return;
  const json = parseJsonObjectLine(raw);
  if (json === undefined) {
    onLine({ raw });
    return;
  }
  const sessionId = stringField(json, 'session_id', 'sessionId');
  const model = stringField(json, 'model');
  const usage = extractUsage(json);
  const bodyText = extractBodyText(json);
  onLine({
    raw,
    json,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(usage !== undefined ? { usage } : {}),
    ...(bodyText !== undefined ? { bodyText } : {}),
  });
};

export const createCopilotStreamParser = (): CopilotStreamParser =>
  createCappedLineFeed<CopilotStreamLine>('copilot-stream', emitLine);
