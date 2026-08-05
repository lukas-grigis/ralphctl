import { describe, expect, it } from 'vitest';
import { reproductionSignalSchema } from '@src/integration/ai/contract/_engine/signals/reproduction/schema.ts';

const TS = '2026-05-23T10:00:00.000Z';

describe('reproductionSignalSchema', () => {
  it('accepts a valid payload with relevant tests and notes', () => {
    const result = reproductionSignalSchema.safeParse({
      type: 'reproduction',
      testPath: 'tests/unit/business/foo/bar.test.ts',
      runCommand: '<test runner> run tests/unit/business/foo/bar.test.ts',
      observedFailure: 'expected 400, got 500\n  at src/routes/foo.ts:42',
      relevantTests: ['tests/unit/business/foo/baz.test.ts'],
      notes: 'Extended the existing empty-input test file rather than adding a new one.',
      timestamp: TS,
    });
    expect(result.success).toBe(true);
  });

  it('accepts an empty relevantTests array — "searched, found nothing" is valid', () => {
    const result = reproductionSignalSchema.safeParse({
      type: 'reproduction',
      testPath: 'tests/unit/business/foo/bar.test.ts',
      runCommand: '<test runner> run tests/unit/business/foo/bar.test.ts',
      observedFailure: 'expected 400, got 500',
      relevantTests: [],
      timestamp: TS,
    });
    expect(result.success).toBe(true);
  });

  it('treats notes as optional', () => {
    const withoutNotes = reproductionSignalSchema.safeParse({
      type: 'reproduction',
      testPath: 'tests/unit/foo.test.ts',
      runCommand: '<test runner> run tests/unit/foo.test.ts',
      observedFailure: 'failure output',
      relevantTests: [],
      timestamp: TS,
    });
    expect(withoutNotes.success).toBe(true);
  });

  it('rejects missing testPath', () => {
    const result = reproductionSignalSchema.safeParse({
      type: 'reproduction',
      runCommand: '<test runner> run tests/unit/foo.test.ts',
      observedFailure: 'failure output',
      relevantTests: [],
      timestamp: TS,
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing runCommand', () => {
    const result = reproductionSignalSchema.safeParse({
      type: 'reproduction',
      testPath: 'tests/unit/foo.test.ts',
      observedFailure: 'failure output',
      relevantTests: [],
      timestamp: TS,
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing observedFailure', () => {
    const result = reproductionSignalSchema.safeParse({
      type: 'reproduction',
      testPath: 'tests/unit/foo.test.ts',
      runCommand: '<test runner> run tests/unit/foo.test.ts',
      relevantTests: [],
      timestamp: TS,
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing relevantTests', () => {
    const result = reproductionSignalSchema.safeParse({
      type: 'reproduction',
      testPath: 'tests/unit/foo.test.ts',
      runCommand: '<test runner> run tests/unit/foo.test.ts',
      observedFailure: 'failure output',
      timestamp: TS,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-array relevantTests', () => {
    const result = reproductionSignalSchema.safeParse({
      type: 'reproduction',
      testPath: 'tests/unit/foo.test.ts',
      runCommand: '<test runner> run tests/unit/foo.test.ts',
      observedFailure: 'failure output',
      relevantTests: 'tests/unit/baz.test.ts',
      timestamp: TS,
    });
    expect(result.success).toBe(false);
  });

  it('rejects the wrong type discriminator', () => {
    const result = reproductionSignalSchema.safeParse({
      type: 'not-reproduction',
      testPath: 'tests/unit/foo.test.ts',
      runCommand: '<test runner> run tests/unit/foo.test.ts',
      observedFailure: 'failure output',
      relevantTests: [],
      timestamp: TS,
    });
    expect(result.success).toBe(false);
  });
});
