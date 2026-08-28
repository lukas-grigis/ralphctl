import { describe, expect, it } from 'vitest';
import { createCapturingBus } from '@tests/fixtures/capturing-event-bus.ts';
import {
  assistantText,
  createGrokAttemptTracker,
  extractGrokMetaUpdate,
  parseGrokJsonLine,
} from '@src/integration/ai/providers/grok/parse-stream.ts';

const drive = (chunks: readonly string[]) => {
  const cap = createCapturingBus();
  const tracker = createGrokAttemptTracker(cap.bus);
  for (const chunk of chunks) tracker.consumeChunk(chunk);
  tracker.flush();
  return { tracker, cap };
};

describe('parseGrokJsonLine', () => {
  it('parses a live text ping sample', () => {
    const obj = parseGrokJsonLine('{"type":"text","data":"ping"}');
    expect(obj).toEqual({ type: 'text', data: 'ping' });
    expect(assistantText(obj!)).toBe('ping');
  });

  it('skips blank, non-JSON, and malformed lines without throwing', () => {
    expect(parseGrokJsonLine('')).toBeUndefined();
    expect(parseGrokJsonLine('   ')).toBeUndefined();
    expect(parseGrokJsonLine('Loaded grok config')).toBeUndefined();
    expect(parseGrokJsonLine('{ not json')).toBeUndefined();
  });
});

describe('extractGrokMetaUpdate', () => {
  it('reads sessionId + usage from an end record', () => {
    const update = extractGrokMetaUpdate({
      type: 'end',
      stopReason: 'end_turn',
      sessionId: '01a047e3-cfea-7b83-8047-31c8c2a39cc8',
      usage: {
        input_tokens: 10,
        output_tokens: 3,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: 1,
      },
    });
    expect(update).toEqual({
      sessionId: '01a047e3-cfea-7b83-8047-31c8c2a39cc8',
      inputTokens: 10,
      outputTokens: 3,
      cacheReadTokens: 2,
      cacheCreationTokens: 1,
    });
  });

  it('reads usage from a usage record', () => {
    const update = extractGrokMetaUpdate({
      type: 'usage',
      usage: { input_tokens: 4, output_tokens: 1 },
    });
    expect(update).toEqual({ inputTokens: 4, outputTokens: 1 });
  });
});

describe('createGrokAttemptTracker', () => {
  it('concatenates text.data, skips thought, and captures end.sessionId', () => {
    const { tracker } = drive([
      '{"type":"text","data":"ping"}\n',
      '{"type":"thought","data":"hmm"}\n',
      '{"type":"available_commands","tools":[]}\n',
      '{"type":"end","stopReason":"end_turn","sessionId":"01a047e3-cfea-7b83-8047-31c8c2a39cc8","usage":{"input_tokens":12,"output_tokens":4}}\n',
    ]);
    expect(tracker.getBody()).toBe('ping');
    expect(tracker.getSessionId()).toBe('01a047e3-cfea-7b83-8047-31c8c2a39cc8');
    expect(tracker.getInputTokens()).toBe(12);
    expect(tracker.getOutputTokens()).toBe(4);
  });

  it('last-write-wins on usage and first sessionId wins', () => {
    const { tracker } = drive([
      '{"type":"usage","usage":{"input_tokens":1,"output_tokens":1}}\n',
      '{"type":"end","sessionId":"first","usage":{"input_tokens":9,"output_tokens":8}}\n',
      '{"type":"end","sessionId":"second","usage":{"input_tokens":99,"output_tokens":88}}\n',
    ]);
    expect(tracker.getSessionId()).toBe('first');
    expect(tracker.getInputTokens()).toBe(99);
    expect(tracker.getOutputTokens()).toBe(88);
  });

  it('skips malformed and unknown types without throwing', () => {
    const { tracker } = drive([
      '\n',
      'not json\n',
      '{ broken\n',
      '{"type":"mystery","data":"x"}\n',
      '{"type":"text","data":"ok"}\n',
    ]);
    expect(tracker.getBody()).toBe('ok');
  });

  it('captures error.message as stream error, appends it to the body, and publishes a warn', () => {
    const { tracker, cap } = drive([
      '{"type":"text","data":"before"}\n',
      '{"type":"error","message":"Session not found locally"}\n',
    ]);
    expect(tracker.getStreamError()).toBe('Session not found locally');
    expect(tracker.getBody()).toBe('beforeSession not found locally');
    expect(
      cap.logs.some(
        (e) => e.level === 'warn' && e.message.includes('CLI reported an error — Session not found locally')
      )
    ).toBe(true);
  });

  it('forwards cache counters from end.usage onto the tracker', () => {
    const { tracker } = drive([
      '{"type":"end","sessionId":"sid-cache","usage":{"input_tokens":10,"output_tokens":3,"cache_read_input_tokens":2,"cache_creation_input_tokens":1}}\n',
    ]);
    expect(tracker.getCacheReadTokens()).toBe(2);
    expect(tracker.getCacheCreationTokens()).toBe(1);
  });

  it('reassembles a line split across chunks', () => {
    const line = '{"type":"text","data":"split body"}';
    const cut = Math.floor(line.length / 2);
    const { tracker } = drive([line.slice(0, cut), `${line.slice(cut)}\n`]);
    expect(tracker.getBody()).toBe('split body');
  });

  it('parses a CRLF-terminated stream — sessionId, body and usage all survive the \\r', () => {
    const { tracker } = drive([
      '{"type":"text","data":"crlf"}\r\n',
      '{"type":"end","sessionId":"sid-crlf","usage":{"input_tokens":7,"output_tokens":9}}\r\n',
    ]);
    expect(tracker.getBody()).toBe('crlf');
    expect(tracker.getSessionId()).toBe('sid-crlf');
    expect(tracker.getInputTokens()).toBe(7);
    expect(tracker.getOutputTokens()).toBe(9);
  });

  it('publishes tool_use / tool_result debug events', () => {
    const { cap } = drive([
      '{"type":"tool_call","toolCallId":"t1","toolName":"write","kind":"write","status":"running","rawInput":{"path":"a"}}\n',
      '{"type":"tool_call_update","toolCallId":"t1","status":"completed","rawOutput":{"ok":true}}\n',
    ]);
    const messages = cap.logs.map((e) => e.message);
    expect(messages).toContain('grok-provider: tool_use');
    expect(messages).toContain('grok-provider: tool_result');
  });
});
