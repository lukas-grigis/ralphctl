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

describe('runEvaluatorTurnUseCase — warning path without critique', () => {
  it('continues without recording critique when warning path has no critique (line 226)', async () => {
    // Arrange: commit-subject changed so plateau is softened to warning, but there is
    // NO critique text. The branch at line 215 (`if critique !== undefined && ...`) must
    // be false so line 226 (`return Result.ok({ task: warned.value, ... })`) executes.
    const task = verifiedTask();
    const ev = failedEval('completeness'); // no critique field

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
      // Critique was NOT recorded (there was none to record)
      expect(result.value.task.attempts.at(-1)?.critique).toBeUndefined();
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

describe('runEvaluatorTurnUseCase — failed without critique (no prior turns)', () => {
  it('continues without critique when evaluator fails with empty critique field', async () => {
    // Failed eval, empty critique string — the `if critique !== undefined && trim() > 0`
    // guard at line 236 should be false, so we reach line 249 with no critique recorded.
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
      // No critique recorded
      expect(result.value.task.attempts.at(-1)?.critique).toBeUndefined();
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
