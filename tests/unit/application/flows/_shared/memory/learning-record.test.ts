import { describe, expect, it } from 'vitest';
import { ParseError } from '@src/domain/value/error/parse-error.ts';
import {
  type LearningRecord,
  parseLearningLine,
  serializeLearningRecord,
} from '@src/application/flows/_shared/memory/learning-record.ts';

const record = (over: Partial<LearningRecord> = {}): LearningRecord => ({
  v: 1,
  id: 'abc123',
  text: 'The build emits ESM only.',
  repo: '/repos/app',
  repoName: 'app',
  taskKind: 'feature',
  sprintId: 'sprint-1',
  taskId: 'task-1',
  timestamp: '2026-05-30T10:00:00.000Z',
  promotedAt: null,
  ...over,
});

describe('parseLearningLine', () => {
  it('round-trips a serialized record', () => {
    const original = record();
    const line = serializeLearningRecord(original);
    const parsed = parseLearningLine(line);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual(original);
  });

  it('returns undefined for a blank line', () => {
    const parsed = parseLearningLine('   ');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toBeUndefined();
  });

  it('preserves a non-null promotedAt', () => {
    const promoted = record({ promotedAt: '2026-05-30T12:00:00.000Z' });
    const parsed = parseLearningLine(serializeLearningRecord(promoted));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value?.promotedAt).toBe('2026-05-30T12:00:00.000Z');
  });

  it('rejects invalid JSON with a ParseError (invalid-json)', () => {
    const parsed = parseLearningLine('{ not json');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toBeInstanceOf(ParseError);
    expect(parsed.error.subCode).toBe('invalid-json');
  });

  it('rejects a JSON object missing required fields with a ParseError (schema-mismatch)', () => {
    const parsed = parseLearningLine(JSON.stringify({ v: 1, id: 'x' }));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toBeInstanceOf(ParseError);
    expect(parsed.error.subCode).toBe('schema-mismatch');
  });

  it('tolerates unknown extra fields (forward-compatible)', () => {
    const withExtra = { ...record(), futureField: 'ignored' };
    const parsed = parseLearningLine(`${JSON.stringify(withExtra)}\n`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual(record());
  });
});
