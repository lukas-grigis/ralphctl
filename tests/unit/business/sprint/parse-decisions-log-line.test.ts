import { describe, expect, it } from 'vitest';
import { parseDecisionsLogLine } from '@src/business/sprint/parse-decisions-log-line.ts';

describe('parseDecisionsLogLine', () => {
  it('parses a fully-tagged line into a DecisionEntry with meta', () => {
    const out = parseDecisionsLogLine('2026-05-21T10:00:00.000Z task-abc deadbee chose X over Y because Z');
    expect(out).toEqual({
      chainId: '',
      at: '2026-05-21T10:00:00.000Z',
      message: 'chose X over Y because Z',
      meta: { taskId: 'task-abc', commitSha: 'deadbee' },
    });
  });

  it('treats `?` columns as missing and omits them from meta', () => {
    const out = parseDecisionsLogLine('2026-05-21T10:00:00.000Z ? ? inferred default');
    expect(out).toEqual({
      chainId: '',
      at: '2026-05-21T10:00:00.000Z',
      message: 'inferred default',
    });
  });

  it('returns undefined on blank lines', () => {
    expect(parseDecisionsLogLine('')).toBeUndefined();
    expect(parseDecisionsLogLine('   ')).toBeUndefined();
  });

  it('returns undefined when the line is missing one of the three positional columns', () => {
    expect(parseDecisionsLogLine('only-one')).toBeUndefined();
    expect(parseDecisionsLogLine('one two')).toBeUndefined();
    expect(parseDecisionsLogLine('one two three')).toBeUndefined();
  });

  it('preserves spaces inside the decision body (only the first three columns are atomic)', () => {
    const out = parseDecisionsLogLine('2026-05-21T10:00:00.000Z ? ? a  body  with  spaces');
    expect(out?.message).toBe('a  body  with  spaces');
  });
});
