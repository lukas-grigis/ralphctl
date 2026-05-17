/**
 * Parser for the JSON envelope `claude -p --output-format json` writes to stdout.
 *
 * The CLI emits ONE JSON object summarising the run:
 *
 *   {"type":"result","subtype":"success","result":"<assistant text>","session_id":"…",…}
 *
 * The harness pulls `.result` (the rendered assistant turn, harness tags included) and
 * `.session_id` (for replay / cost attribution) and ignores everything else. Mirrors v1's
 * `claude-adapter.parseJsonOutput` (`ralphctl/src/integration/ai/providers/claude-adapter.ts`)
 * — the simplest, most robust thing that works.
 *
 * Failure modes are deliberately lenient: if the captured stdout doesn't parse as JSON, or
 * `.result` is missing / non-string, the body falls back to the raw stdout so any inline
 * harness tags still surface to `parseHarnessSignals` rather than being silently dropped.
 */

export interface ClaudeEnvelope {
  /** Assistant body — `.result` when parsed cleanly, otherwise raw stdout verbatim. */
  readonly body: string;
  /** `session_id` from the envelope, when present. */
  readonly sessionId: string | undefined;
  /** Model name from the envelope, when present. */
  readonly model: string | undefined;
}

/**
 * Parse the full stdout captured from one `claude -p --output-format json` run.
 *
 * The input is the entire stdout string — the caller is responsible for accumulating it and
 * waiting for the child to fully close (`'close'` event) before calling this; doing it any
 * earlier risks parsing a truncated envelope.
 */
export const parseClaudeJsonEnvelope = (stdout: string): ClaudeEnvelope => {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return { body: '', sessionId: undefined, model: undefined };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Not JSON — surface the raw output so inline harness tags still parse.
    return { body: stdout, sessionId: undefined, model: undefined };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { body: stdout, sessionId: undefined, model: undefined };
  }
  const obj = parsed as Record<string, unknown>;
  const result = stringField(obj, 'result');
  const sessionId = stringField(obj, 'session_id', 'sessionId');
  const model = stringField(obj, 'model');
  return {
    body: result ?? stdout,
    sessionId,
    model,
  };
};

const stringField = (obj: Record<string, unknown>, ...names: readonly string[]): string | undefined => {
  for (const name of names) {
    const v = obj[name];
    if (typeof v === 'string') return v;
  }
  return undefined;
};
