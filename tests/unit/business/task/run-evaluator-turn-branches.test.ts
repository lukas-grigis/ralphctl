/**
 * Supplemental unit tests for run-evaluator-turn.ts — covers branches not reached
 * by the main run-evaluator-turn.test.ts file.
 *
 * Specific gaps:
 *   - warning path where no critique is present (line 226: return with warned.value directly)
 *   - progress verdict path (critique-shift exemption) with no-exit continuation
 *   - failed eval with no critique and no plateau — continues with no critique recorded
 *   - turnRecord is undefined on the malformed/no-signal path
 *   - turnRecord populated correctly on the passed path
 */

import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { recordRunningAttemptVerification } from '@src/domain/entity/task-attempts.ts';
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

const failedEval = (dimName: string, extras?: Partial<EvaluationSignal>): EvaluationSignal =>
  evaluation('failed', {
    dimensions: [{ dimension: dimName, passed: false, finding: 'placeholder failure finding' }],
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

describe('runEvaluatorTurnUseCase — warning path with synthesized critique', () => {
  it('records a synthesized critique on the warning path when the evaluator left critique empty', async () => {
    // Arrange: commit-subject changed so plateau is softened to warning, with NO explicit
    // critique text. Post Part 1(b) the use case synthesizes a critique from the failed
    // dimension's finding so the warning path still feeds the next generator turn.
    const task = verifiedTask();
    const ev = failedEval('completeness'); // no explicit critique field; finding present

    const result = await runEvaluatorTurnUseCase({
      task,
      priorTurns: [turnRecord(ev, { commitSubject: 'WIP: option A' })],
      currentCommitSubject: 'WIP: option B',
      plateauThreshold: 2,
      callEvaluate: async () => Result.ok([ev] as readonly HarnessSignal[]),
      evaluationFile: EVAL_FILE,
      logger: noopLogger,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // No exit — loop continues
      expect(result.value.exit).toBeUndefined();
      // Warning was recorded on the attempt
      const warning = result.value.task.attempts.at(-1)?.warning;
      expect(warning?.kind).toBe('plateau');
      // Critique IS recorded now — synthesized from the failed dimension's finding.
      expect(result.value.task.attempts.at(-1)?.critique).toBe('[completeness] placeholder failure finding');
      // turnRecord still populated
      expect(result.value.turnRecord).toBeDefined();
    }
  });
});

describe('runEvaluatorTurnUseCase — progress verdict (critique-shift)', () => {
  it('continues without exit when critique-shift exemption fires (progress verdict)', async () => {
    // Arrange: same dimension, but critique text shifted significantly (Jaccard < 0.5)
    // → computePlateauVerdict returns 'progress', loop continues normally.
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
      // Critique recorded for next generator turn
      expect(result.value.task.attempts.at(-1)?.critique).toBe(currentCritique);
      // turnRecord populated
      expect(result.value.turnRecord).toBeDefined();
      expect(result.value.evaluation?.status).toBe('failed');
    }
  });
});

describe('runEvaluatorTurnUseCase — failed with empty critique synthesizes from findings (no prior turns)', () => {
  it('records a synthesized critique when the evaluator fails with an empty critique string', async () => {
    // Failed eval, empty critique string — post Part 1(b) the use case synthesizes a critique
    // from the failed dimension's finding so the loop's error wire never goes silent.
    const task = verifiedTask();
    const failed = evaluation('failed', {
      dimensions: [{ dimension: 'correctness', passed: false, finding: 'wrong' }],
      critique: '',
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
      // Critique synthesized from the failed dimension's finding.
      expect(result.value.task.attempts.at(-1)?.critique).toBe('[correctness] wrong');
      // turnRecord still present — the loop can detect future plateaus
      expect(result.value.turnRecord).toBeDefined();
    }
  });
});

describe('runEvaluatorTurnUseCase — turnRecord on terminal paths', () => {
  it('turnRecord is undefined on the no-signal (malformed) path', async () => {
    const task = verifiedTask();
    const result = await runEvaluatorTurnUseCase({
      task,
      plateauThreshold: 2,
      callEvaluate: async () => Result.ok([] as readonly HarnessSignal[]),
      evaluationFile: EVAL_FILE,
      logger: noopLogger,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.exit?.kind).toBe('malformed');
      expect(result.value.turnRecord).toBeUndefined();
    }
  });

  it('turnRecord is defined on the plateau exit path', async () => {
    const task = verifiedTask();
    const ev = failedEval('completeness', { critique: 'same critique text unchanged' });

    const result = await runEvaluatorTurnUseCase({
      task,
      priorTurns: [turnRecord(ev, { critique: 'same critique text unchanged' })],
      plateauThreshold: 2,
      callEvaluate: async () => Result.ok([ev] as readonly HarnessSignal[]),
      evaluationFile: EVAL_FILE,
      logger: noopLogger,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.exit?.kind).toBe('plateau');
      // turnRecord is populated even on plateau exit (the leaf appends it to history)
      expect(result.value.turnRecord).toBeDefined();
    }
  });

  it('evaluation is returned on the passed exit path', async () => {
    const task = verifiedTask();
    const passedEval = evaluation('passed');

    const result = await runEvaluatorTurnUseCase({
      task,
      plateauThreshold: 2,
      callEvaluate: async () => Result.ok([passedEval] as readonly HarnessSignal[]),
      evaluationFile: EVAL_FILE,
      logger: noopLogger,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.exit?.kind).toBe('passed');
      expect(result.value.evaluation?.status).toBe('passed');
    }
  });
});
