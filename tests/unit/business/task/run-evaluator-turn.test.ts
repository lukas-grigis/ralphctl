import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { recordRunningAttemptVerification } from '@src/domain/entity/task.ts';
import type { EvaluationSignal, HarnessSignal } from '@src/domain/signal.ts';
import { FIXED_NOW, makeInProgressTaskWithRunningAttempt } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import type { PlateauTurnRecord } from '@src/business/task/plateau-detection.ts';
import { runEvaluatorTurnUseCase } from '@src/business/task/run-evaluator-turn.ts';

const verifiedTask = () => {
  const recorded = recordRunningAttemptVerification(makeInProgressTaskWithRunningAttempt());
  if (!recorded.ok) throw new Error(`fixture: ${recorded.error.message}`);
  return recorded.value;
};

const evaluation = (
  status: 'passed' | 'failed' | 'malformed',
  overrides?: Partial<EvaluationSignal>
): EvaluationSignal => ({
  type: 'evaluation',
  status,
  dimensions: [],
  timestamp: FIXED_NOW,
  ...overrides,
});

const failedEval = (dim: string, extras?: Partial<EvaluationSignal>): EvaluationSignal =>
  evaluation('failed', {
    dimensions: [{ dimension: dim, passed: false, finding: 'placeholder failure finding' }],
    ...extras,
  });

const turnRecord = (
  ev: EvaluationSignal,
  extras?: { critique?: string; commitSubject?: string }
): PlateauTurnRecord => ({
  evaluation: ev,
  ...(extras?.critique !== undefined ? { critique: extras.critique } : {}),
  ...(extras?.commitSubject !== undefined ? { commitSubject: extras.commitSubject } : {}),
});

const EVAL_FILE = 'rounds/1/evaluator/evaluation.md';

describe('runEvaluatorTurnUseCase', () => {
  it('returns passed exit when evaluator emits a passed verdict', async () => {
    const task = verifiedTask();
    const result = await runEvaluatorTurnUseCase({
      task,
      plateauThreshold: 2,
      callEvaluate: async () => Result.ok([evaluation('passed')] as readonly HarnessSignal[]),
      evaluationFile: EVAL_FILE,
      logger: noopLogger,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.exit?.kind).toBe('passed');
      expect(result.value.task.attempts.at(-1)?.evaluation?.file).toBe(EVAL_FILE);
    }
  });

  it('returns malformed exit when no evaluation signal is found', async () => {
    const task = verifiedTask();
    const result = await runEvaluatorTurnUseCase({
      task,
      plateauThreshold: 2,
      callEvaluate: async () => Result.ok([] as readonly HarnessSignal[]),
      evaluationFile: EVAL_FILE,
      logger: noopLogger,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.exit?.kind).toBe('malformed');
  });

  it('returns malformed exit when evaluator status is malformed', async () => {
    const task = verifiedTask();
    const result = await runEvaluatorTurnUseCase({
      task,
      plateauThreshold: 2,
      callEvaluate: async () => Result.ok([evaluation('malformed')] as readonly HarnessSignal[]),
      evaluationFile: EVAL_FILE,
      logger: noopLogger,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.exit?.kind).toBe('malformed');
  });

  // Regression: the 2026-05-20 verified-correct base case. Identical scores, same dim, no
  // commit-subject change → plateau fires at the default threshold of 2.
  it('plateau fires on repeated identical scores with no commit-progress (default threshold=2)', async () => {
    const task = verifiedTask();
    const ev = failedEval('completeness', { critique: 'still missing X' });
    const result = await runEvaluatorTurnUseCase({
      task,
      priorTurns: [turnRecord(ev, { critique: 'still missing X' })],
      plateauThreshold: 2,
      callEvaluate: async () => Result.ok([ev] as readonly HarnessSignal[]),
      evaluationFile: EVAL_FILE,
      logger: noopLogger,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.exit?.kind).toBe('plateau');
      if (result.value.exit?.kind === 'plateau') {
        expect(result.value.exit.dimensions).toEqual(['completeness']);
      }
    }
  });

  it('no plateau when a failed dimension drops out of the failed set (PASS on the next turn)', async () => {
    const task = verifiedTask();
    const prior = failedEval('correctness');
    // The same dim now passes — `failedDimensions` is empty so the set-equality precondition
    // no longer holds and the predicate returns `none`.
    const current = evaluation('failed', {
      dimensions: [{ dimension: 'correctness', passed: true, finding: 'better' }],
      critique: 'almost there',
    });
    const result = await runEvaluatorTurnUseCase({
      task,
      priorTurns: [turnRecord(prior)],
      plateauThreshold: 2,
      callEvaluate: async () => Result.ok([current] as readonly HarnessSignal[]),
      evaluationFile: EVAL_FILE,
      logger: noopLogger,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.exit).toBeUndefined();
  });

  it('commit-progress softens plateau to warning-only (records warning, loop continues)', async () => {
    const task = verifiedTask();
    const ev = failedEval('completeness', { critique: 'still missing X' });
    const result = await runEvaluatorTurnUseCase({
      task,
      priorTurns: [turnRecord(ev, { critique: 'still missing X', commitSubject: 'WIP: try option A' })],
      plateauThreshold: 2,
      currentCommitSubject: 'WIP: try option B',
      callEvaluate: async () => Result.ok([ev] as readonly HarnessSignal[]),
      evaluationFile: EVAL_FILE,
      logger: noopLogger,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.exit).toBeUndefined();
      const warning = result.value.task.attempts.at(-1)?.warning;
      expect(warning?.kind).toBe('plateau');
      if (warning?.kind === 'plateau') {
        expect(warning.dimensions).toEqual(['completeness']);
      }
      // Critique still gets fed forward for the next generator turn.
      expect(result.value.task.attempts.at(-1)?.critique).toBe('still missing X');
    }
  });

  it('threshold=3: same dim flagged twice (one prior + current) → no plateau yet', async () => {
    const task = verifiedTask();
    const ev = failedEval('completeness', { critique: 'still missing X' });
    const result = await runEvaluatorTurnUseCase({
      task,
      priorTurns: [turnRecord(ev)],
      plateauThreshold: 3,
      callEvaluate: async () => Result.ok([ev] as readonly HarnessSignal[]),
      evaluationFile: EVAL_FILE,
      logger: noopLogger,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.exit).toBeUndefined();
  });

  it('threshold=3: three consecutive (two prior + current) on same dim → plateau fires', async () => {
    const task = verifiedTask();
    const ev = failedEval('completeness', { critique: 'still missing X' });
    const result = await runEvaluatorTurnUseCase({
      task,
      priorTurns: [turnRecord(ev), turnRecord(ev)],
      plateauThreshold: 3,
      callEvaluate: async () => Result.ok([ev] as readonly HarnessSignal[]),
      evaluationFile: EVAL_FILE,
      logger: noopLogger,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.exit?.kind).toBe('plateau');
  });

  it('plateau fires when critique text is near-identical (Jaccard ≥ 0.5)', async () => {
    const task = verifiedTask();
    // Tiny tweak — single-character whitespace difference; trigram sets overlap heavily.
    const priorCritique = 'still missing the early-return branch in the parser';
    const currentCritique = 'still missing the early-return branch in the parser.';
    const prior = failedEval('completeness', { critique: priorCritique });
    const current = failedEval('completeness', { critique: currentCritique });
    const result = await runEvaluatorTurnUseCase({
      task,
      priorTurns: [turnRecord(prior, { critique: priorCritique })],
      plateauThreshold: 2,
      callEvaluate: async () => Result.ok([current] as readonly HarnessSignal[]),
      evaluationFile: EVAL_FILE,
      logger: noopLogger,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.exit?.kind).toBe('plateau');
  });

  it('no plateau when critique text shifted (Jaccard < 0.5)', async () => {
    const task = verifiedTask();
    const priorCritique = 'still missing the early-return branch in the parser';
    const currentCritique = 'overflow on huge inputs; bounds check needed in the buffer alloc path';
    const prior = failedEval('completeness', { critique: priorCritique });
    const current = failedEval('completeness', { critique: currentCritique });
    const result = await runEvaluatorTurnUseCase({
      task,
      priorTurns: [turnRecord(prior, { critique: priorCritique })],
      plateauThreshold: 2,
      callEvaluate: async () => Result.ok([current] as readonly HarnessSignal[]),
      evaluationFile: EVAL_FILE,
      logger: noopLogger,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.exit).toBeUndefined();
      expect(result.value.task.attempts.at(-1)?.critique).toBe(currentCritique);
    }
  });

  it('predicate does not crash on empty dimensions — treats as no plateau evidence', async () => {
    const task = verifiedTask();
    const empty = evaluation('failed', { dimensions: [] });
    const result = await runEvaluatorTurnUseCase({
      task,
      priorTurns: [turnRecord(empty)],
      plateauThreshold: 2,
      callEvaluate: async () => Result.ok([empty] as readonly HarnessSignal[]),
      evaluationFile: EVAL_FILE,
      logger: noopLogger,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.exit).toBeUndefined();
  });

  it('spawn error (callEvaluate fails) bubbles up as a Result.error — no crash', async () => {
    const task = verifiedTask();
    const evError = new Error('spawn ENOENT') as unknown as Error & { readonly _tag: 'fake' };
    const result = await runEvaluatorTurnUseCase({
      task,
      plateauThreshold: 2,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      callEvaluate: async () => Result.error(evError as any),
      evaluationFile: EVAL_FILE,
      logger: noopLogger,
    });
    expect(result.ok).toBe(false);
  });

  it('continues (no exit) when failed but with a fresh critique and no prior turns', async () => {
    const task = verifiedTask();
    const failed: EvaluationSignal = evaluation('failed', {
      dimensions: [{ dimension: 'correctness', passed: false, finding: 'wrong' }],
      critique: 'try again with X',
    });
    const result = await runEvaluatorTurnUseCase({
      task,
      plateauThreshold: 2,
      callEvaluate: async () => Result.ok([failed] as readonly HarnessSignal[]),
      evaluationFile: EVAL_FILE,
      logger: noopLogger,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.exit).toBeUndefined();
      expect(result.value.task.attempts.at(-1)?.critique).toBe('try again with X');
    }
  });
});
