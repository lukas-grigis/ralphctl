/**
 * Line-oriented parser for `claude -p --verbose --output-format stream-json` (JSONL):
 *
 *   {"type":"system","subtype":"init","session_id":"…","model":"claude-…", …}
 *   {"type":"assistant","message":{ … },"session_id":"…"}
 *   {"type":"user","message":{ … tool result … },"session_id":"…"}
 *   {"type":"result","subtype":"success","result":"<assistant text>","session_id":"…", …}
 *
 * The body is the `result` event's `.result` string; the session id is the EARLIEST seen (every
 * event restates it, so first-wins keeps it stable). Non-JSON and unknown lines are skipped, so an
 * empty or malformed stream yields `body=''` and no session id rather than a throw.
 */

import type {
  ClaudeLiveUsage,
  ClaudeStreamLine,
  ClaudeStreamParser,
  ClaudeUsage,
} from '@src/integration/ai/providers/_engine/claude-stream.ts';
import { createCappedLineFeed, parseJsonObjectLine } from '@src/integration/ai/providers/_engine/line-feed.ts';
import { numberField, recordField, stringField } from '@src/integration/ai/providers/_engine/json-field.ts';

const emitLine = (raw: string, onLine: (line: ClaudeStreamLine) => void): void => {
  if (raw.length === 0) return;
  const json = parseJsonObjectLine(raw);
  onLine(json === undefined ? { raw } : { raw, json });
};

// `result.usage` and per-turn `message.usage` share these field names.
const extractUsage = (u: Record<string, unknown>): ClaudeUsage => {
  const inputTokens = numberField(u, 'input_tokens', 'inputTokens');
  const outputTokens = numberField(u, 'output_tokens', 'outputTokens');
  const cacheReadTokens = numberField(u, 'cache_read_input_tokens', 'cacheReadInputTokens');
  const cacheCreationTokens = numberField(u, 'cache_creation_input_tokens', 'cacheCreationInputTokens');
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
  };
};

const toLiveUsage = ({ inputTokens, cacheReadTokens, cacheCreationTokens }: ClaudeUsage): ClaudeLiveUsage => ({
  ...(inputTokens !== undefined ? { liveInputTokens: inputTokens } : {}),
  ...(cacheReadTokens !== undefined ? { liveCacheReadTokens: cacheReadTokens } : {}),
  ...(cacheCreationTokens !== undefined ? { liveCacheCreationTokens: cacheCreationTokens } : {}),
});

export const createClaudeStreamParser = (): ClaudeStreamParser => {
  const lineFeed = createCappedLineFeed<ClaudeStreamLine>('claude-stream', emitLine);
  // Reassigned from the latest `result` event, never built by per-line concatenation.
  let body = '';
  let sessionId: string | undefined;
  let model: string | undefined;
  let usage: ClaudeUsage = {};
  let liveUsage: ClaudeLiveUsage = {};

  const ingest = (line: ClaudeStreamLine): void => {
    const json = line.json;
    if (json === undefined) return;
    sessionId ??= stringField(json, 'session_id', 'sessionId');
    const type = stringField(json, 'type');
    if (type === 'system') model ??= stringField(json, 'model');
    if (type === 'assistant') {
      // A content-only delta carries no usage and must not clobber the last captured turn.
      const u = recordField(recordField(json, 'message'), 'usage');
      if (u !== undefined) liveUsage = toLiveUsage(extractUsage(u));
    }
    if (type === 'result') {
      body = stringField(json, 'result') ?? body;
      const u = recordField(json, 'usage');
      if (u !== undefined) usage = extractUsage(u);
    }
  };

  return {
    feed: lineFeed.feed,
    flush: lineFeed.flush,
    ingest,
    snapshot: () => ({ body, sessionId, model, usage, liveUsage }),
  };
};
