import { describe, expect, it } from 'vitest';
import { fromJsonTask, toJsonTask } from '@src/integration/persistence/task/task.schema.ts';
import { makeDoneTask } from '@tests/fixtures/domain.ts';

/**
 * The harness-owned `criteriaVerdicts` map round-trips through `tasks.json`. The field is OPTIONAL on
 * read so files written before it existed still load (missing → `undefined`), and the three durable
 * states — `passed` / `failed` / `unknown` — all survive the serialise → parse boundary.
 */

const persistedDoneTask = (): Record<string, unknown> => toJsonTask(makeDoneTask()) as Record<string, unknown>;

describe('task.schema — criteriaVerdicts round-trip', () => {
  it('round-trips a full passed/failed/unknown verdict map', () => {
    const payload = { ...persistedDoneTask(), criteriaVerdicts: { C1: 'passed', C2: 'failed', C3: 'unknown' } };
    const parsed = fromJsonTask(payload);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.criteriaVerdicts).toEqual({ C1: 'passed', C2: 'failed', C3: 'unknown' });
    }
  });

  it('loads a legacy task without criteriaVerdicts as undefined (tolerant read)', () => {
    const parsed = fromJsonTask(persistedDoneTask());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.criteriaVerdicts).toBeUndefined();
    }
  });

  it('rejects an unrecognised verdict value', () => {
    const payload = { ...persistedDoneTask(), criteriaVerdicts: { C1: 'maybe' } };
    expect(fromJsonTask(payload).ok).toBe(false);
  });
});
