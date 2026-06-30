import { describe, expect, it } from 'vitest';
import type { Result } from '@src/domain/result.ts';
import type { InProgressTask, VerificationCriterion } from '@src/domain/entity/task.ts';
import { createTask } from '@src/domain/entity/task-factory.ts';
import { recordRunningAttemptVerification, startNextAttempt } from '@src/domain/entity/task-attempts.ts';
import { markTaskDone } from '@src/domain/entity/task-settle.ts';
import { applyCriteriaVerdicts } from '@src/domain/entity/task-criteria.ts';
import type { CriterionVerdict } from '@src/domain/signal.ts';
import { FIXED_LATER, FIXED_NOW, FIXED_REPOSITORY_ID, makeApprovedTicket } from '@tests/fixtures/domain.ts';

const unwrap = <T, E>(r: Result<T, E>): T => {
  if (!r.ok) throw new Error('unexpected error in test fixture');
  return r.value as T;
};

const THREE_CRITERIA: readonly VerificationCriterion[] = [
  { id: 'C1', assertion: 'first', check: 'manual' },
  { id: 'C2', assertion: 'second', check: 'manual' },
  { id: 'C3', assertion: 'third', check: 'manual' },
];

const inProgressWithCriteria = (criteria: readonly VerificationCriterion[]): InProgressTask => {
  const ticket = makeApprovedTicket();
  const todo = unwrap(
    createTask({
      name: 'multi-criteria',
      steps: ['s1'],
      verificationCriteria: [...criteria],
      order: 1,
      ticketId: ticket.id,
      repositoryId: FIXED_REPOSITORY_ID,
    })
  );
  return unwrap(startNextAttempt(todo, FIXED_NOW, 'session-1'));
};

describe('applyCriteriaVerdicts', () => {
  it('seeds every current criterion as unknown, then overlays the round`s graded verdicts', () => {
    const task = inProgressWithCriteria(THREE_CRITERIA);
    const graded: readonly CriterionVerdict[] = [
      { id: 'C1', passed: true },
      { id: 'C2', passed: false },
    ];
    const out = applyCriteriaVerdicts(task, graded);
    // C1/C2 graded this round; C3 has a slot but no verdict yet → unknown.
    expect(out.criteriaVerdicts).toEqual({ C1: 'passed', C2: 'failed', C3: 'unknown' });
  });

  it('returns the task unchanged when no verdicts were graded this round (never fabricates slots)', () => {
    const task = inProgressWithCriteria(THREE_CRITERIA);
    const out = applyCriteriaVerdicts(task, []);
    expect(out).toBe(task);
    expect(out.criteriaVerdicts).toBeUndefined();
  });

  it('preserves a prior verdict for a criterion not graded this round', () => {
    const task = inProgressWithCriteria(THREE_CRITERIA);
    const round1 = applyCriteriaVerdicts(task, [{ id: 'C1', passed: true }]);
    // Round 2 only grades C2 — C1 must keep its passed verdict, C3 stays unknown.
    const round2 = applyCriteriaVerdicts(round1, [{ id: 'C2', passed: true }]);
    expect(round2.criteriaVerdicts).toEqual({ C1: 'passed', C2: 'passed', C3: 'unknown' });
  });

  it('flips a prior verdict when the same criterion is regraded', () => {
    const task = inProgressWithCriteria([{ id: 'C1', assertion: 'first', check: 'manual' }]);
    const passed = applyCriteriaVerdicts(task, [{ id: 'C1', passed: true }]);
    const regressed = applyCriteriaVerdicts(passed, [{ id: 'C1', passed: false }]);
    expect(regressed.criteriaVerdicts).toEqual({ C1: 'failed' });
  });

  it('prunes a stale prior id that is no longer a current criterion', () => {
    const task = inProgressWithCriteria([{ id: 'C1', assertion: 'first', check: 'manual' }]);
    // Inject a stale verdict for a criterion no longer on the task, then fold a fresh round.
    const stale = applyCriteriaVerdicts(task, [{ id: 'C1', passed: true }]);
    const withGhost: InProgressTask = { ...stale, criteriaVerdicts: { C1: 'passed', GHOST: 'failed' } };
    const out = applyCriteriaVerdicts(withGhost, [{ id: 'C1', passed: true }]);
    expect(out.criteriaVerdicts).toEqual({ C1: 'passed' });
  });
});

describe('markTaskDone — criteriaVerdicts carry-through (clone semantics)', () => {
  it('carries the folded per-criterion verdicts onto the reconstructed done task', () => {
    const task = inProgressWithCriteria(THREE_CRITERIA);
    const folded = applyCriteriaVerdicts(task, [
      { id: 'C1', passed: true },
      { id: 'C2', passed: true },
      { id: 'C3', passed: true },
    ]);
    const verified = unwrap(recordRunningAttemptVerification(folded));
    const done = unwrap(markTaskDone(verified, FIXED_LATER));
    expect(done.status).toBe('done');
    expect(done.criteriaVerdicts).toEqual({ C1: 'passed', C2: 'passed', C3: 'passed' });
  });

  it('leaves criteriaVerdicts undefined on a done task that never had a verdict folded', () => {
    const task = inProgressWithCriteria(THREE_CRITERIA);
    const verified = unwrap(recordRunningAttemptVerification(task));
    const done = unwrap(markTaskDone(verified, FIXED_LATER));
    expect(done.criteriaVerdicts).toBeUndefined();
  });
});
