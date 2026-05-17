import { describe, expect, it } from 'vitest';
import { parseClaudeJsonEnvelope } from '@src/integration/ai/providers/claude/parse-stream.ts';

describe('parseClaudeJsonEnvelope', () => {
  it('extracts result and session_id from the canonical envelope', () => {
    const stdout = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: '<task-verified>all good</task-verified>',
      session_id: 'sess-abc',
      model: 'claude-opus-4-7',
      num_turns: 3,
    });
    const env = parseClaudeJsonEnvelope(stdout);
    expect(env.body).toBe('<task-verified>all good</task-verified>');
    expect(env.sessionId).toBe('sess-abc');
    expect(env.model).toBe('claude-opus-4-7');
  });

  it('accepts the envelope wrapped in surrounding whitespace / trailing newlines', () => {
    const stdout = `\n  ${JSON.stringify({ result: 'hi', session_id: 's1' })}\n\n`;
    const env = parseClaudeJsonEnvelope(stdout);
    expect(env.body).toBe('hi');
    expect(env.sessionId).toBe('s1');
  });

  it('preserves multi-line content (newlines / harness tags) inside result', () => {
    // Real Claude often emits result with embedded newlines (JSON-encoded as \n).
    const result = '<progress>step 1</progress>\n<task-verified>done</task-verified>';
    const stdout = JSON.stringify({ result, session_id: 's-multiline' });
    const env = parseClaudeJsonEnvelope(stdout);
    expect(env.body).toBe(result);
    expect(env.sessionId).toBe('s-multiline');
  });

  it('falls back to raw stdout when JSON parsing fails (still surfaces inline harness tags)', () => {
    const stdout = 'not json at all <task-complete/>';
    const env = parseClaudeJsonEnvelope(stdout);
    expect(env.body).toBe(stdout);
    expect(env.sessionId).toBeUndefined();
  });

  it('falls back to raw stdout when .result is missing from the envelope', () => {
    const stdout = JSON.stringify({ session_id: 's1', model: 'm' });
    const env = parseClaudeJsonEnvelope(stdout);
    expect(env.body).toBe(stdout);
    expect(env.sessionId).toBe('s1');
    expect(env.model).toBe('m');
  });

  it('ignores non-string .result fields and falls back to raw stdout', () => {
    const stdout = JSON.stringify({ result: 42, session_id: 's1' });
    const env = parseClaudeJsonEnvelope(stdout);
    expect(env.body).toBe(stdout);
    expect(env.sessionId).toBe('s1');
  });

  it('returns empty body / undefined ids for empty stdout', () => {
    const env = parseClaudeJsonEnvelope('');
    expect(env.body).toBe('');
    expect(env.sessionId).toBeUndefined();
    expect(env.model).toBeUndefined();
  });

  it('accepts the realistic envelope shape Claude actually produces', () => {
    // Captured from `claude -p --output-format json` against the real CLI: extra fields,
    // nested usage object, all on one line.
    const stdout =
      '{"type":"result","subtype":"success","is_error":false,"duration_ms":4896,' +
      '"num_turns":1,"result":"<task-verified>ok</task-verified>",' +
      '"stop_reason":"end_turn","session_id":"4074df74-053f-4ef7-ae4b-f10c3999cb14",' +
      '"total_cost_usd":0.08,"usage":{"input_tokens":9,"output_tokens":122},' +
      '"modelUsage":{"claude-sonnet-4-5":{"inputTokens":9}}}';
    const env = parseClaudeJsonEnvelope(stdout);
    expect(env.body).toBe('<task-verified>ok</task-verified>');
    expect(env.sessionId).toBe('4074df74-053f-4ef7-ae4b-f10c3999cb14');
  });
});
