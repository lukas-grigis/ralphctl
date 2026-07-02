import { describe, expect, it } from 'vitest';
import type { CriteriaVerdicts, VerificationCriterion } from '@src/domain/entity/task.ts';
import { composeCriteriaHistory } from '@src/business/task/compose-criteria-history.ts';

const criteria: readonly VerificationCriterion[] = [
  { id: 'C1', assertion: 'typecheck passes', check: 'auto', command: 'tsc' },
  { id: 'C2', assertion: 'the export is wired', check: 'manual' },
  { id: 'C3', assertion: 'edge cases covered', check: 'manual' },
];

describe('composeCriteriaHistory', () => {
  it('returns "" when the verdict map is absent (round 1, never graded)', () => {
    expect(composeCriteriaHistory({ verificationCriteria: criteria, verdicts: undefined })).toBe('');
  });

  it('returns "" when there are no declared criteria', () => {
    expect(composeCriteriaHistory({ verificationCriteria: [], verdicts: { C1: 'passed' } })).toBe('');
  });

  it('returns "" when every criterion is still unknown (seeded but never graded)', () => {
    const verdicts: CriteriaVerdicts = { C1: 'unknown', C2: 'unknown', C3: 'unknown' };
    expect(composeCriteriaHistory({ verificationCriteria: criteria, verdicts })).toBe('');
  });

  it('renders a compact, deterministic block for a mixed verdict map with the k-of-N summary', () => {
    const verdicts: CriteriaVerdicts = { C1: 'passed', C2: 'passed', C3: 'failed' };
    const out = composeCriteriaHistory({ verificationCriteria: criteria, verdicts });
    expect(out).toBe(
      [
        '## Prior criteria verdicts',
        '',
        'Durable per-criterion verdicts recorded by earlier rounds — 2 of 3 done-criteria passing as of the last graded round:',
        '- C1: passing',
        '- C2: passing',
        '- C3: failing',
      ].join('\n')
    );
  });

  it('renders a not-yet-graded line for a criterion still unknown while others are graded', () => {
    const verdicts: CriteriaVerdicts = { C1: 'passed', C2: 'failed' }; // C3 absent → unknown
    const out = composeCriteriaHistory({ verificationCriteria: criteria, verdicts });
    expect(out).toContain('1 of 3 done-criteria passing');
    expect(out).toContain('- C1: passing');
    expect(out).toContain('- C2: failing');
    expect(out).toContain('- C3: not yet graded');
  });

  it('renders criteria in their declared order regardless of verdict-map key order', () => {
    const verdicts: CriteriaVerdicts = { C3: 'failed', C1: 'passed', C2: 'failed' };
    const out = composeCriteriaHistory({ verificationCriteria: criteria, verdicts });
    const c1 = out.indexOf('C1');
    const c2 = out.indexOf('C2');
    const c3 = out.indexOf('C3');
    expect(c1).toBeLessThan(c2);
    expect(c2).toBeLessThan(c3);
  });
});
