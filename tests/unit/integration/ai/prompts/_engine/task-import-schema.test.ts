import { describe, expect, it } from 'vitest';
import {
  TaskImportSpecSchema,
  VerificationCriterionImportSchema,
} from '@src/integration/ai/prompts/_engine/task-import-schema.ts';

const baseSpec = {
  name: 'do-the-thing',
  projectPath: '/tmp/ralph/repo',
  steps: ['step 1'],
};

describe('VerificationCriterionImportSchema', () => {
  it('accepts a manual criterion (no command)', () => {
    const r = VerificationCriterionImportSchema.safeParse({ id: 'C1', assertion: 'X', check: 'manual' });
    expect(r.success).toBe(true);
  });

  it('accepts an auto criterion with a non-empty command', () => {
    const r = VerificationCriterionImportSchema.safeParse({
      id: 'C1',
      assertion: 'X',
      check: 'auto',
      command: 'npm test',
    });
    expect(r.success).toBe(true);
  });

  it('rejects an auto criterion missing the command field', () => {
    const r = VerificationCriterionImportSchema.safeParse({ id: 'C1', assertion: 'X', check: 'auto' });
    expect(r.success).toBe(false);
  });

  it('rejects an auto criterion with an empty command', () => {
    const r = VerificationCriterionImportSchema.safeParse({
      id: 'C1',
      assertion: 'X',
      check: 'auto',
      command: '   ',
    });
    expect(r.success).toBe(false);
  });

  it('rejects a manual criterion that carries a command', () => {
    const r = VerificationCriterionImportSchema.safeParse({
      id: 'C1',
      assertion: 'X',
      check: 'manual',
      command: 'npm test',
    });
    expect(r.success).toBe(false);
  });

  it('rejects unknown fields (strict object)', () => {
    const r = VerificationCriterionImportSchema.safeParse({
      id: 'C1',
      assertion: 'X',
      check: 'manual',
      extra: 'nope',
    });
    expect(r.success).toBe(false);
  });
});

describe('TaskImportSpecSchema', () => {
  it('accepts a task with structured verificationCriteria entries', () => {
    const r = TaskImportSpecSchema.safeParse({
      ...baseSpec,
      verificationCriteria: [
        { id: 'C1', assertion: 'X', check: 'auto', command: 'npm test' },
        { id: 'C2', assertion: 'Y', check: 'manual' },
      ],
    });
    expect(r.success).toBe(true);
  });

  it('rejects bare-string verificationCriteria entries (no read-time normalization on the AI surface)', () => {
    const r = TaskImportSpecSchema.safeParse({
      ...baseSpec,
      verificationCriteria: ['X', 'Y'],
    });
    expect(r.success).toBe(false);
  });

  it('rejects an empty verificationCriteria array', () => {
    const r = TaskImportSpecSchema.safeParse({
      ...baseSpec,
      verificationCriteria: [],
    });
    expect(r.success).toBe(false);
  });

  it('rejects a task with one auto criterion missing its command', () => {
    const r = TaskImportSpecSchema.safeParse({
      ...baseSpec,
      verificationCriteria: [{ id: 'C1', assertion: 'X', check: 'auto' }],
    });
    expect(r.success).toBe(false);
  });
});
