import { describe, expect, it } from 'vitest';
import { ParseError } from '@src/domain/value/error/parse-error.ts';
import {
  deriveDecisionId,
  deriveLearningId,
  isDecision,
  isLearning,
  isRetired,
  learningRecordSchema,
  type LearningRecord,
  parseLearningLine,
  recordKind,
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

  it('round-trips the structured context + applies-to fields', () => {
    const structured = record({ context: 'wiring the config reader', appliesTo: 'config / io layer' });
    const parsed = parseLearningLine(serializeLearningRecord(structured));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual(structured);
  });

  it('parses a legacy row that omits context / applies-to (back-compat)', () => {
    // record() builds a v1-shaped row without the structured fields.
    const parsed = parseLearningLine(serializeLearningRecord(record()));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value?.context).toBeUndefined();
    expect(parsed.value?.appliesTo).toBeUndefined();
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

describe('learningRecordSchema text constraint', () => {
  it('rejects an empty text (the required Insight)', () => {
    const parsed = learningRecordSchema.safeParse(record({ text: '' }));
    expect(parsed.success).toBe(false);
  });

  it('rejects a whitespace-only text', () => {
    const parsed = learningRecordSchema.safeParse(record({ text: '   \t\n ' }));
    expect(parsed.success).toBe(false);
  });

  it('rejects an empty-text record via parseLearningLine (schema-mismatch)', () => {
    const parsed = parseLearningLine(serializeLearningRecord(record({ text: '   ' })));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toBeInstanceOf(ParseError);
    expect(parsed.error.subCode).toBe('schema-mismatch');
  });

  it('preserves a padded non-empty text byte-for-byte (refine, not transform)', () => {
    const padded = record({ text: '  leading and trailing space preserved  ' });
    const parsed = parseLearningLine(serializeLearningRecord(padded));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value?.text).toBe('  leading and trailing space preserved  ');
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

describe('deriveDecisionId', () => {
  it('is a deterministic 16-char hex digest in its own namespace', () => {
    const id = deriveDecisionId('/repos/app', 'feature', 'Adopt hexagonal layering.');
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(deriveDecisionId('/repos/app', 'feature', 'Adopt hexagonal layering.')).toBe(id);
  });

  it('keeps an identical sentence distinct from its learning id (so the shared ledger never collapses them)', () => {
    const text = 'The build emits ESM only.';
    expect(deriveDecisionId('/repos/app', 'feature', text)).not.toBe(deriveLearningId('/repos/app', 'feature', text));
  });
});

describe('kind + retire helpers', () => {
  it('recordKind defaults a legacy (no-kind) row to learning', () => {
    expect(recordKind(record())).toBe('learning');
    expect(recordKind(record({ kind: 'learning' }))).toBe('learning');
    expect(recordKind(record({ kind: 'decision' }))).toBe('decision');
  });

  it('isLearning / isDecision partition by kind, legacy rows counting as learnings', () => {
    expect(isLearning(record())).toBe(true);
    expect(isDecision(record())).toBe(false);
    expect(isDecision(record({ kind: 'decision' }))).toBe(true);
    expect(isLearning(record({ kind: 'decision' }))).toBe(false);
  });

  it('isRetired treats absent / null as live, an ISO stamp as retired', () => {
    expect(isRetired(record())).toBe(false);
    expect(isRetired(record({ retiredAt: null }))).toBe(false);
    expect(isRetired(record({ retiredAt: '2026-06-29T00:00:00.000Z' }))).toBe(true);
  });

  it('round-trips a decision row with kind through parse/serialize', () => {
    const decision = record({ kind: 'decision', text: 'one bus per wire' });
    const parsed = parseLearningLine(serializeLearningRecord(decision));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value?.kind).toBe('decision');
  });

  it('parses a retired row and a legacy row with no kind/retiredAt', () => {
    const retired = parseLearningLine(serializeLearningRecord(record({ retiredAt: '2026-06-29T00:00:00.000Z' })));
    expect(retired.ok).toBe(true);
    if (retired.ok) expect(isRetired(retired.value as LearningRecord)).toBe(true);

    // A legacy line that predates both fields still validates.
    const legacy = parseLearningLine(
      JSON.stringify({
        v: 1,
        id: 'legacy',
        text: 'legacy insight',
        repo: '/repos/app',
        repoName: 'app',
        taskKind: 'feature',
        sprintId: 's',
        taskId: 't',
        timestamp: '2026-05-30T10:00:00.000Z',
        promotedAt: null,
      })
    );
    expect(legacy.ok).toBe(true);
    if (legacy.ok) {
      expect(recordKind(legacy.value as LearningRecord)).toBe('learning');
      expect(isRetired(legacy.value as LearningRecord)).toBe(false);
    }
  });
});
