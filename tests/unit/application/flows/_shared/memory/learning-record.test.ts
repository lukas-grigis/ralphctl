import { describe, expect, it } from 'vitest';
import { ParseError } from '@src/domain/value/error/parse-error.ts';
import {
  deriveLearningId,
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

describe('deriveLearningId', () => {
  it('is a deterministic 16-char hex digest', () => {
    const id = deriveLearningId('/repos/app', 'feature', 'The build emits ESM only.');
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(deriveLearningId('/repos/app', 'feature', 'The build emits ESM only.')).toBe(id);
  });

  it('collapses incidental formatting differences (trim / case / whitespace runs) onto one id', () => {
    const base = deriveLearningId('/repos/app', 'feature', 'The build emits ESM only.');
    expect(deriveLearningId('/repos/app', 'feature', '  the   build emits esm only.  ')).toBe(base);
  });

  it('distinguishes repo, taskKind, and genuinely different prose', () => {
    const base = deriveLearningId('/repos/app', 'feature', 'The build emits ESM only.');
    expect(deriveLearningId('/repos/other', 'feature', 'The build emits ESM only.')).not.toBe(base);
    expect(deriveLearningId('/repos/app', 'bugfix', 'The build emits ESM only.')).not.toBe(base);
    expect(deriveLearningId('/repos/app', 'feature', 'A different insight entirely.')).not.toBe(base);
  });
});
