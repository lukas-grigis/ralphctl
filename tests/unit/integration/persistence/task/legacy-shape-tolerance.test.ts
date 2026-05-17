import { describe, expect, it } from 'vitest';
import { fromJsonAttempt } from '@src/integration/persistence/task/attempt.schema.ts';
import { VerificationSchema } from '@src/integration/persistence/task/verification.schema.ts';
import { EvaluationSchema } from '@src/integration/persistence/task/evaluation.schema.ts';

/**
 * REQ-8 from the file-based-provider refactor: pre-refactor `tasks.json` files written with
 * `verification: { output: '<body>' }` and `evaluation: { output: '<body>', status, file }`
 * must load on the new code path. The `output` field is silently dropped — the AI's prose is
 * no longer a first-class artifact on the attempt.
 *
 * These tests pin the loader's tolerance so a future schema refactor can't break in-flight
 * sprints without first updating this file.
 */

describe('VerificationSchema — legacy shape tolerance', () => {
  it('accepts the new shape (empty object marker) and returns `{}`', () => {
    const parsed = VerificationSchema.safeParse({});
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual({});
  });

  it('accepts the pre-refactor shape `{ output: "..." }` and silently drops the body', () => {
    const parsed = VerificationSchema.safeParse({ output: 'a long AI body that used to live here' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual({});
  });

  it('tolerates unknown extra fields a future writer may have stamped', () => {
    const parsed = VerificationSchema.safeParse({ output: 'old', signalsFile: '/tmp/x.json', somethingNew: 42 });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual({});
  });
});

describe('EvaluationSchema — legacy shape tolerance', () => {
  it('accepts the new shape (status + file)', () => {
    const parsed = EvaluationSchema.safeParse({ status: 'passed', file: 'rounds/1/evaluator/evaluation.md' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.status).toBe('passed');
      expect(parsed.data.file).toBe('rounds/1/evaluator/evaluation.md');
    }
  });

  it('accepts the pre-refactor shape (output + status + file) and silently drops the body', () => {
    const parsed = EvaluationSchema.safeParse({
      output: 'the entire AI evaluator response, potentially huge',
      status: 'failed',
      file: 'rounds/2/evaluator/evaluation.md',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual({ status: 'failed', file: 'rounds/2/evaluator/evaluation.md' });
    }
  });

  it('still requires status + file (the structural fields the use case depends on)', () => {
    expect(EvaluationSchema.safeParse({ output: 'orphan body' }).success).toBe(false);
    expect(EvaluationSchema.safeParse({ status: 'passed' }).success).toBe(false);
  });
});

describe('Attempt round-trip — legacy verification body silently dropped on load', () => {
  it('a pre-refactor verified attempt loads cleanly; the prose body is not surfaced on the loaded entity', () => {
    const legacyAttempt = {
      n: 1,
      startedAt: '2026-05-01T10:00:00.000Z',
      status: 'verified',
      finishedAt: '2026-05-01T11:00:00.000Z',
      verification: { output: 'multi-megabyte assistant response that used to pin the heap' },
    };
    const parsed = fromJsonAttempt(legacyAttempt);
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.value.status === 'verified') {
      expect(parsed.value.verification).toEqual({});
      expect((parsed.value.verification as Record<string, unknown>)['output']).toBeUndefined();
    }
  });

  it('a pre-refactor attempt with a legacy evaluation drops the evaluation body too', () => {
    const legacyAttempt = {
      n: 2,
      startedAt: '2026-05-01T10:00:00.000Z',
      status: 'failed',
      finishedAt: '2026-05-01T10:30:00.000Z',
      evaluation: {
        output: 'huge legacy body',
        status: 'failed',
        file: 'rounds/1/evaluator/evaluation.md',
      },
    };
    const parsed = fromJsonAttempt(legacyAttempt);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.evaluation).toEqual({
        status: 'failed',
        file: 'rounds/1/evaluator/evaluation.md',
      });
      expect((parsed.value.evaluation as Record<string, unknown> | undefined)?.['output']).toBeUndefined();
    }
  });
});
