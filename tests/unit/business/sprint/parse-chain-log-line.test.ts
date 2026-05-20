import { describe, expect, it } from 'vitest';
import { parseChainLogLine } from '@src/business/sprint/parse-chain-log-line.ts';

describe('parseChainLogLine', () => {
  it('skips blank lines', () => {
    expect(parseChainLogLine('')).toBeUndefined();
    expect(parseChainLogLine('   ')).toBeUndefined();
  });

  it('skips chain-log boundary marker lines', () => {
    expect(parseChainLogLine('=== chain-run r1 implement started 2026-05-08T10:00:00.000Z ===')).toBeUndefined();
    expect(
      parseChainLogLine('=== chain-run r1 implement completed 2026-05-08T10:05:00.000Z duration=300000ms steps=2 ===')
    ).toBeUndefined();
  });

  it('skips malformed JSON lines', () => {
    expect(parseChainLogLine('{ not valid')).toBeUndefined();
    expect(parseChainLogLine('"a string"')).toBeUndefined(); // not an object
    expect(parseChainLogLine('42')).toBeUndefined();
  });

  it('skips JSON missing the required type / at fields', () => {
    expect(parseChainLogLine('{"chainId":"r1"}')).toBeUndefined();
    expect(parseChainLogLine('{"type":"chain-started"}')).toBeUndefined();
    expect(parseChainLogLine('{"at":"2026-05-08T10:00:00.000Z"}')).toBeUndefined();
  });

  it('parses chain-started into a ChainLogEntry with flowId in meta', () => {
    const entry = parseChainLogLine(
      JSON.stringify({ type: 'chain-started', chainId: 'r1', flowId: 'implement', at: '2026-05-08T10:00:00.000Z' })
    );
    expect(entry).toBeDefined();
    expect(entry?.chainId).toBe('r1');
    expect(entry?.event).toBe('chain-started');
    expect(entry?.timestamp).toBe('2026-05-08T10:00:00.000Z');
    expect(entry?.meta?.['flowId']).toBe('implement');
  });

  it('parses chain-step-completed and exposes elementName via meta', () => {
    const entry = parseChainLogLine(
      JSON.stringify({
        type: 'chain-step-completed',
        chainId: 'r1',
        elementName: 'ensure-progress-file',
        durationMs: 12,
        at: '2026-05-08T10:00:01.000Z',
      })
    );
    expect(entry).toBeDefined();
    expect(entry?.event).toBe('chain-step-completed');
    expect(entry?.meta?.['elementName']).toBe('ensure-progress-file');
  });

  it('parses log events; preserves message + meta and synthesises empty chainId', () => {
    const entry = parseChainLogLine(
      JSON.stringify({
        type: 'log',
        level: 'info',
        message: 'task t-1 settled',
        meta: { taskId: 't-1' },
        at: '2026-05-08T10:01:00.000Z',
      })
    );
    expect(entry).toBeDefined();
    expect(entry?.chainId).toBe('');
    expect(entry?.level).toBe('info');
    expect(entry?.message).toBe('task t-1 settled');
    expect(entry?.meta?.['taskId']).toBe('t-1');
  });

  it('parses task-attempt-started; lifts taskId into meta so the stale heuristic finds it', () => {
    const entry = parseChainLogLine(
      JSON.stringify({
        type: 'task-attempt-started',
        taskId: 't-1',
        sessionId: 's-abc',
        at: '2026-05-08T10:02:00.000Z',
      })
    );
    expect(entry).toBeDefined();
    expect(entry?.meta?.['taskId']).toBe('t-1');
    expect(entry?.meta?.['sessionId']).toBe('s-abc');
  });

  it('returns undefined for trailing newline-only lines (split-induced empty strings)', () => {
    expect(parseChainLogLine('\n')).toBeUndefined();
  });
});
