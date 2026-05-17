import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { recordRunningAttemptVerification } from '@src/domain/entity/task.ts';
import type { EvaluationSignal, HarnessSignal } from '@src/domain/signal.ts';
import { FIXED_NOW, makeInProgressTaskWithRunningAttempt } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
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

const EVAL_FILE = 'rounds/1/evaluator/evaluation.md';

describe('runEvaluatorTurnUseCase', () => {
  it('returns passed exit when evaluator emits a passed verdict', async () => {
    const task = verifiedTask();
    const result = await runEvaluatorTurnUseCase({
      task,
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
      callEvaluate: async () => Result.ok([evaluation('malformed')] as readonly HarnessSignal[]),
      evaluationFile: EVAL_FILE,
      logger: noopLogger,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.exit?.kind).toBe('malformed');
  });

  it('detects plateau when failed dimensions repeat across turns', async () => {
    const task = verifiedTask();
    const failed: EvaluationSignal = evaluation('failed', {
      dimensions: [{ dimension: 'correctness', score: 2, passed: false, finding: 'wrong' }],
    });
    const result = await runEvaluatorTurnUseCase({
      task,
      priorEvaluation: failed,
      callEvaluate: async () => Result.ok([failed] as readonly HarnessSignal[]),
      evaluationFile: EVAL_FILE,
      logger: noopLogger,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.exit?.kind).toBe('plateau');
      if (result.value.exit?.kind === 'plateau') {
        expect(result.value.exit.dimensions).toContain('correctness');
      }
    }
  });

  it('continues (no exit) when failed but with a fresh critique', async () => {
    const task = verifiedTask();
    const failed: EvaluationSignal = evaluation('failed', {
      dimensions: [{ dimension: 'correctness', score: 2, passed: false, finding: 'wrong' }],
      critique: 'try again with X',
    });
    const result = await runEvaluatorTurnUseCase({
      task,
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
