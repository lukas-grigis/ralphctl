import { describe, expect, it } from 'vitest';
import { createClaudeStreamParser } from '@src/integration/ai/providers/claude/parse-stream.ts';
import type { ClaudeStreamLine } from '@src/integration/ai/providers/_engine/claude-stream.ts';

/** Drive a parser through one or more chunks; return the accumulated envelope + collected lines. */
const drive = (chunks: readonly string[]) => {
  const parser = createClaudeStreamParser();
  const seen: ClaudeStreamLine[] = [];
  const onLine = (l: ClaudeStreamLine): void => {
    seen.push(l);
    parser.ingest(l);
  };
  for (const c of chunks) parser.feed(c, onLine);
  parser.flush(onLine);
  return { envelope: parser.snapshot(), lines: seen };
};

describe('createClaudeStreamParser', () => {
  it("empty input → body='', sessionId/model undefined", () => {
    const { envelope, lines } = drive([]);
    expect(envelope.body).toBe('');
    expect(envelope.sessionId).toBeUndefined();
    expect(envelope.model).toBeUndefined();
    expect(lines).toEqual([]);
  });

  it('system init event captures sessionId and model', () => {
    const init = JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 'sess-init',
      model: 'claude-opus-4-8',
    });
    const { envelope } = drive([`${init}\n`]);
    expect(envelope.sessionId).toBe('sess-init');
    expect(envelope.model).toBe('claude-opus-4-8');
    // No `result` event yet — body stays empty.
    expect(envelope.body).toBe('');
  });

  it("body comes from the result event's .result field, not from assistant deltas", () => {
    const init = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1', model: 'm' });
    const delta1 = JSON.stringify({ type: 'assistant', message: { content: 'partial 1' }, session_id: 'sess-1' });
    const delta2 = JSON.stringify({ type: 'assistant', message: { content: 'partial 2' }, session_id: 'sess-1' });
    const finalBody = '<task-verified>all good</task-verified>';
    const resultEvt = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: finalBody,
      session_id: 'sess-1',
      num_turns: 2,
    });
    const { envelope } = drive([`${init}\n${delta1}\n${delta2}\n${resultEvt}\n`]);
    expect(envelope.body).toBe(finalBody);
    expect(envelope.sessionId).toBe('sess-1');
  });

  it("missing result event (stream cut short) → body='', sessionId still captured from init", () => {
    const init = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-cut', model: 'm' });
    const delta = JSON.stringify({ type: 'assistant', message: { content: 'half a thought' }, session_id: 'sess-cut' });
    const { envelope } = drive([`${init}\n${delta}\n`]);
    expect(envelope.body).toBe('');
    expect(envelope.sessionId).toBe('sess-cut');
  });

  it('skips malformed, non-JSON, and banner lines silently while processing valid events', () => {
    const init = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-noisy', model: 'm' });
    const resultEvt = JSON.stringify({ type: 'result', result: 'hello', session_id: 'sess-noisy' });
    const chunks = [
      'Loaded claude config\n', // banner
      '\n', // blank
      '{ not json at all\n', // malformed
      `${init}\n`,
      'still talking…\n', // plain text noise
      `${resultEvt}\n`,
    ];
    const { envelope } = drive(chunks);
    expect(envelope.body).toBe('hello');
    expect(envelope.sessionId).toBe('sess-noisy');
  });

  it('reassembles a line split across chunks (mid-line chunk boundary)', () => {
    const init = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-split', model: 'm' });
    const resultEvt = JSON.stringify({ type: 'result', result: 'split body', session_id: 'sess-split' });
    const full = `${init}\n${resultEvt}\n`;
    // Slice mid-way through the result line.
    const cut = init.length + 1 + Math.floor(resultEvt.length / 2);
    const a = full.slice(0, cut);
    const b = full.slice(cut);
    const { envelope } = drive([a, b]);
    expect(envelope.body).toBe('split body');
    expect(envelope.sessionId).toBe('sess-split');
  });

  it('first sessionId wins — later events do not overwrite the earliest seen', () => {
    const init = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-first', model: 'm' });
    const later = JSON.stringify({ type: 'assistant', message: {}, session_id: 'sess-later' });
    const resultEvt = JSON.stringify({ type: 'result', result: 'ok', session_id: 'sess-later' });
    const { envelope } = drive([`${init}\n${later}\n${resultEvt}\n`]);
    expect(envelope.sessionId).toBe('sess-first');
    expect(envelope.body).toBe('ok');
  });

  it('flush emits a trailing partial line without a newline', () => {
    const resultEvt = JSON.stringify({ type: 'result', result: 'tail', session_id: 's' });
    // No trailing newline — must still be parsed via flush().
    const { envelope } = drive([resultEvt]);
    expect(envelope.body).toBe('tail');
    expect(envelope.sessionId).toBe('s');
  });

  it('accepts the realistic event shape Claude actually produces (extra fields, nested usage)', () => {
    const init = JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: '4074df74-053f-4ef7-ae4b-f10c3999cb14',
      model: 'claude-sonnet-4-6',
      tools: ['Read', 'Write'],
      cwd: '/repo',
    });
    const resultEvt = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 4896,
      num_turns: 1,
      result: '<task-verified>ok</task-verified>',
      stop_reason: 'end_turn',
      session_id: '4074df74-053f-4ef7-ae4b-f10c3999cb14',
      total_cost_usd: 0.08,
      usage: { input_tokens: 9, output_tokens: 122 },
    });
    const { envelope } = drive([`${init}\n${resultEvt}\n`]);
    expect(envelope.body).toBe('<task-verified>ok</task-verified>');
    expect(envelope.sessionId).toBe('4074df74-053f-4ef7-ae4b-f10c3999cb14');
    expect(envelope.model).toBe('claude-sonnet-4-6');
  });

  it('liveUsage = LAST assistant turn message.usage; cumulative result.usage captured separately', () => {
    const init = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-live', model: 'm' });
    const turn1 = JSON.stringify({
      type: 'assistant',
      message: {
        content: 'turn 1',
        usage: { input_tokens: 1000, cache_read_input_tokens: 40000, cache_creation_input_tokens: 2000 },
      },
      session_id: 'sess-live',
    });
    const turn2 = JSON.stringify({
      type: 'assistant',
      message: {
        content: 'turn 2',
        usage: { input_tokens: 1500, cache_read_input_tokens: 53000, cache_creation_input_tokens: 500 },
      },
      session_id: 'sess-live',
    });
    // Cumulative result.usage is much larger than any single turn (sum across turns).
    const resultEvt = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'done',
      session_id: 'sess-live',
      usage: {
        input_tokens: 2500,
        output_tokens: 800,
        cache_read_input_tokens: 187000,
        cache_creation_input_tokens: 2500,
      },
    });
    const { envelope } = drive([`${init}\n${turn1}\n${turn2}\n${resultEvt}\n`]);

    // Live = LAST assistant turn (turn2), not turn1 and not the cumulative result.
    expect(envelope.liveUsage).toEqual({
      inputTokens: 1500,
      cacheReadTokens: 53000,
      cacheCreationTokens: 500,
    });
    // Cumulative result.usage captured separately and untouched by the live path.
    expect(envelope.usage).toEqual({
      inputTokens: 2500,
      outputTokens: 800,
      cacheReadTokens: 187000,
      cacheCreationTokens: 2500,
    });
  });

  it('usage-less assistant events do not clobber a captured liveUsage', () => {
    const init = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-clob', model: 'm' });
    const withUsage = JSON.stringify({
      type: 'assistant',
      message: { content: 'has usage', usage: { input_tokens: 700, cache_read_input_tokens: 30000 } },
      session_id: 'sess-clob',
    });
    // Subsequent content-only delta carries no usage — must NOT reset liveUsage.
    const noUsage = JSON.stringify({ type: 'assistant', message: { content: 'no usage' }, session_id: 'sess-clob' });
    const resultEvt = JSON.stringify({ type: 'result', result: 'ok', session_id: 'sess-clob' });
    const { envelope } = drive([`${init}\n${withUsage}\n${noUsage}\n${resultEvt}\n`]);

    expect(envelope.liveUsage).toEqual({ inputTokens: 700, cacheReadTokens: 30000 });
  });

  it('no assistant usage anywhere → liveUsage stays empty', () => {
    const init = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-none', model: 'm' });
    const delta = JSON.stringify({ type: 'assistant', message: { content: 'plain' }, session_id: 'sess-none' });
    const resultEvt = JSON.stringify({ type: 'result', result: 'ok', session_id: 'sess-none' });
    const { envelope } = drive([`${init}\n${delta}\n${resultEvt}\n`]);
    expect(envelope.liveUsage).toEqual({});
  });
});
