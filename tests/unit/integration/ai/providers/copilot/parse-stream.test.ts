import { describe, expect, it } from 'vitest';
import {
  createCopilotStreamParser,
  type CopilotStreamLine,
} from '@src/integration/ai/providers/copilot/parse-stream.ts';

/** Drive a parser through one or more chunks; return every line it emitted. */
const drive = (chunks: readonly string[]): readonly CopilotStreamLine[] => {
  const parser = createCopilotStreamParser();
  const seen: CopilotStreamLine[] = [];
  for (const c of chunks) parser.feed(c, (l) => seen.push(l));
  parser.flush((l) => seen.push(l));
  return seen;
};

describe('createCopilotStreamParser — extractBodyText', () => {
  it('recognises assistant.message_delta with data.deltaContent (Copilot CLI v1)', () => {
    const evt = JSON.stringify({
      type: 'assistant.message_delta',
      data: { deltaContent: '<progress>working</progress>' },
    });
    const [line] = drive([`${evt}\n`]);
    expect(line?.bodyText).toBe('<progress>working</progress>');
  });

  it('recognises assistant.message with data.content (Copilot CLI v1 final)', () => {
    const evt = JSON.stringify({
      type: 'assistant.message',
      data: { content: '<task-verified>all good</task-verified>' },
    });
    const [line] = drive([`${evt}\n`]);
    expect(line?.bodyText).toBe('<task-verified>all good</task-verified>');
  });

  it('recognises response.output_text.delta with top-level .delta (OpenAI Responses API)', () => {
    const evt = JSON.stringify({ type: 'response.output_text.delta', delta: 'speculative branch text' });
    const [line] = drive([`${evt}\n`]);
    expect(line?.bodyText).toBe('speculative branch text');
  });

  it('recognises content_block_delta with .delta.text (Anthropic SSE protocol)', () => {
    const evt = JSON.stringify({ type: 'content_block_delta', delta: { text: 'anthropic-shape text' } });
    const [line] = drive([`${evt}\n`]);
    expect(line?.bodyText).toBe('anthropic-shape text');
  });

  it('recognises message with top-level .content (generic shape)', () => {
    const evt = JSON.stringify({ type: 'message', content: 'generic shape text' });
    const [line] = drive([`${evt}\n`]);
    expect(line?.bodyText).toBe('generic shape text');
  });

  it('returns undefined bodyText for an unrecognised event type (forensic fall-through path)', () => {
    // Headless adapter must see `line.json !== undefined` AND `line.bodyText === undefined`
    // for an unknown event so it can push `line.raw` into the body buffer. This test pins
    // that contract from the parser side.
    const evt = JSON.stringify({ type: 'tool_call.delta', data: { foo: 'bar' } });
    const [line] = drive([`${evt}\n`]);
    expect(line?.json).toBeDefined();
    expect(line?.bodyText).toBeUndefined();
  });

  it('does not treat a session-id meta line as body text', () => {
    const evt = JSON.stringify({ session_id: 'sess-1', model: 'gpt-5.1' });
    const [line] = drive([`${evt}\n`]);
    expect(line?.sessionId).toBe('sess-1');
    expect(line?.model).toBe('gpt-5.1');
    expect(line?.bodyText).toBeUndefined();
  });

  it('plain-text lines (no JSON) pass through as raw without bodyText (adapter pushes raw)', () => {
    const [line] = drive(['<task-complete/>\n']);
    expect(line?.json).toBeUndefined();
    expect(line?.raw).toBe('<task-complete/>');
    expect(line?.bodyText).toBeUndefined();
  });

  it('content_block_delta with non-string .delta.text returns undefined (precise structure match)', () => {
    // We do NOT blindly stringify unknown shapes. If `delta.text` is missing or wrong type,
    // bodyText stays undefined — the line falls through to the adapter's raw-push path.
    const evt = JSON.stringify({ type: 'content_block_delta', delta: { not_text: 'ignored' } });
    const [line] = drive([`${evt}\n`]);
    expect(line?.bodyText).toBeUndefined();
  });

  it('response.output_text.delta with non-string .delta returns undefined', () => {
    const evt = JSON.stringify({ type: 'response.output_text.delta', delta: { nested: 'no' } });
    const [line] = drive([`${evt}\n`]);
    expect(line?.bodyText).toBeUndefined();
  });
});
