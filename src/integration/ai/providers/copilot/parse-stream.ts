/**
 * Line-oriented parser for `copilot --output-format json` (JSONL). Mirrors the shape of
 * `parse-claude-stream.ts` so the Copilot adapter can drive the same accumulation pattern.
 *
 * The Copilot CLI emits one JSON object per line; non-JSON lines (rare; usually banner /
 * status) pass through as raw text. We parse metadata (session/model/usage) and conservatively
 * extract assistant body text from known event shapes.
 */

/**
 * Token counts the Copilot CLI may report on a JSON meta line. Every field is optional —
 * Copilot's `--output-format=json` documents the `session_id` / `model` keys but does NOT
 * commit to surfacing per-spawn usage. The parser extracts whatever lands in the meta payload
 * and the adapter forwards what is present.
 */
export interface CopilotUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export interface CopilotStreamLine {
  /** Raw line text (no trailing newline). */
  readonly raw: string;
  /** Parsed JSON object when the line was a valid JSON record; absent for plain lines. */
  readonly json?: Record<string, unknown>;
  /** Convenience: `json.session_id` (or `json.sessionId`) when present, for the adapter to log. */
  readonly sessionId?: string;
  /** Convenience: `json.model` when present on the meta line. */
  readonly model?: string;
  /** Convenience: token counters pulled from any `usage` sub-object on the meta line. */
  readonly usage?: CopilotUsage;
  /**
   * Assistant body text extracted from a known JSON event shape.
   * Absent for metadata-only records.
   */
  readonly bodyText?: string;
}

export interface CopilotStreamParser {
  /** Feed a chunk of stdout. Calls `onLine` once per complete line. */
  feed(chunk: string, onLine: (line: CopilotStreamLine) => void): void;
  /** Flush a trailing partial line if any (called once on child exit). */
  flush(onLine: (line: CopilotStreamLine) => void): void;
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

const extractBodyText = (json: Record<string, unknown>): string | undefined => {
  const eventType = stringField(json, 'type');
  const data = json['data'];
  if (!isRecord(data)) return undefined;
  // Conservative extraction: only known assistant-content events.
  if (eventType === 'assistant.message_delta') {
    return stringField(data, 'deltaContent');
  }
  if (eventType === 'assistant.message') {
    return stringField(data, 'content');
  }
  return undefined;
};

export const createCopilotStreamParser = (): CopilotStreamParser => {
  let buffer = '';
  const emit = (raw: string, onLine: (line: CopilotStreamLine) => void): void => {
    if (raw.length === 0) return;
    if (raw.startsWith('{') && raw.endsWith('}')) {
      try {
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
