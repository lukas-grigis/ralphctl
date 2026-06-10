/**
 * D2 — producer-side plateau-record stamps.
 *
 * These tests assert that the `turnRecord` returned by `runEvaluatorTurnUseCase` carries:
 *   (a) the verdict kind the plateau predicate assigned this turn, and
 *   (b) the `changedFilesHash` threaded from props.
 *
 * The turnRecord is the harness's only durable per-turn state — it is what the NEXT evaluator
 * turn reads to decide whether a plateau has occurred. A mutant that drops either field would
 * silently break plateau detection or the warning cap derivation without any existing test
 * catching it.
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

const failedEval = (dim: string, extras?: Partial<EvaluationSignal>): EvaluationSignal =>
  evaluation('failed', {
    dimensions: [{ dimension: dim, passed: false, finding: 'placeholder failure finding' }],
    ...extras,
  });

const priorTurnWith = (
  ev: EvaluationSignal,
  extras?: { critique?: string; changedFilesHash?: string; verdict?: PlateauTurnRecord['verdict'] }
): PlateauTurnRecord => ({
  evaluation: ev,
  ...(extras?.critique !== undefined ? { critique: extras.critique } : {}),
  ...(extras?.changedFilesHash !== undefined ? { changedFilesHash: extras.changedFilesHash } : {}),
  ...(extras?.verdict !== undefined ? { verdict: extras.verdict } : {}),
});

const EVAL_FILE = 'rounds/1/evaluator/evaluation.md';
const HASH_A = 'sha256:aaaa';
const HASH_B = 'sha256:bbbb';

describe('runEvaluatorTurnUseCase — turnRecord verdict stamp (D2)', () => {
  it("failed turn with no plateau history → turnRecord.verdict is 'none'", async () => {
    // First turn ever: no prior turns → predicate returns 'none'. The turnRecord must carry
    // that verdict so the NEXT turn's cap derivation sees it in history.
    const task = verifiedTask();
    const ev = failedEval('correctness', { critique: 'needs more work' });
    const result = await runEvaluatorTurnUseCase({
      task,
      priorTurns: [],
      plateauThreshold: 2,
      changedFilesHash: HASH_A,
      callEvaluate: async () => Result.ok([ev] as readonly HarnessSignal[]),
      evaluationFile: EVAL_FILE,
      logger: noopLogger,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.exit).toBeUndefined();
    expect(result.value.turnRecord).toBeDefined();
    expect(result.value.turnRecord?.verdict).toBe('none');
  });

  it("soften path → turnRecord.verdict is 'warning'", async () => {
    // Same dim fails but the changedFilesHash differs → plateau softened to warning.
    // The turnRecord must carry verdict='warning' so the cap counter can be derived from
    // history on the next turn without threading state through ctx.
    const task = verifiedTask();
    const ev = failedEval('correctness', { critique: 'still needs work' });
    const result = await runEvaluatorTurnUseCase({
      task,
      priorTurns: [priorTurnWith(ev, { changedFilesHash: HASH_A })],
      plateauThreshold: 2,
      changedFilesHash: HASH_B,
      callEvaluate: async () => Result.ok([ev] as readonly HarnessSignal[]),
      evaluationFile: EVAL_FILE,
      logger: noopLogger,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.exit).toBeUndefined();
    // The softening must be recorded as a warning on the attempt.
    expect(result.value.task.attempts.at(-1)?.warning?.kind).toBe('plateau');
    expect(result.value.turnRecord).toBeDefined();
    // Mutant-kill: a mutant that drops the verdict stamp on this path would leave 'verdict' as
    // undefined, which would make the warning cap derivable only from a count of 'warning'
    // entries — already broken without this stamp.
    expect(result.value.turnRecord?.verdict).toBe('warning');
  });

  it("plateau exit → turnRecord.verdict is 'plateau'", async () => {
    // Threshold=2, one prior with the same dim and same hash → cap hit → plateau fires.
    const task = verifiedTask();
    const ev = failedEval('correctness', { critique: 'same critique' });
    const result = await runEvaluatorTurnUseCase({
      task,
      priorTurns: [priorTurnWith(ev, { changedFilesHash: HASH_A, critique: 'same critique' })],
      plateauThreshold: 2,
      changedFilesHash: HASH_A, // identical hash → work-product exemption does NOT apply
      callEvaluate: async () => Result.ok([ev] as readonly HarnessSignal[]),
      evaluationFile: EVAL_FILE,
      logger: noopLogger,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.exit?.kind).toBe('plateau');
    expect(result.value.turnRecord).toBeDefined();
    expect(result.value.turnRecord?.verdict).toBe('plateau');
  });

  it("progress path (critique-shift) → turnRecord.verdict is 'progress'", async () => {
    // Critique shifted materially vs the prior → exemption → progress. The loop continues
    // without exit and the turnRecord carries verdict='progress'.
    const task = verifiedTask();
    const priorCritique = 'still missing the early-return branch in the parser';
    const currentCritique = 'overflow on huge inputs; bounds check needed in the buffer alloc path';
    const prior = failedEval('correctness', { critique: priorCritique });
    const current = failedEval('correctness', { critique: currentCritique });
    const result = await runEvaluatorTurnUseCase({
      task,
      priorTurns: [priorTurnWith(prior, { critique: priorCritique })],
      plateauThreshold: 2,
      callEvaluate: async () => Result.ok([current] as readonly HarnessSignal[]),
      evaluationFile: EVAL_FILE,
      logger: noopLogger,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.exit).toBeUndefined();
    expect(result.value.turnRecord).toBeDefined();
    // Mutant-kill: a mutant that always stamps 'none' instead of the predicate's actual verdict
    // would let this assertion pass only on the no-plateau path — not on progress.
    expect(result.value.turnRecord?.verdict).toBe('progress');
  });
});

describe('runEvaluatorTurnUseCase — turnRecord changedFilesHash threading (D2)', () => {
  it('changedFilesHash from props is threaded onto the turnRecord', async () => {
    // Mutant-kill: a mutant that drops the changedFilesHash assignment in baseRecord would
    // leave it undefined. The next evaluator turn reads it from priorTurns to decide whether
    // the work-product exemption applies — a missing hash degrades to the commit-subject proxy,
    // silently breaking fingerprint-based plateau softening.
    const task = verifiedTask();
    const ev = failedEval('correctness', { critique: 'needs work' });
    const result = await runEvaluatorTurnUseCase({
      task,
      priorTurns: [],
      plateauThreshold: 3,
      changedFilesHash: HASH_B,
      callEvaluate: async () => Result.ok([ev] as readonly HarnessSignal[]),
      evaluationFile: EVAL_FILE,
      logger: noopLogger,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.turnRecord?.changedFilesHash).toBe(HASH_B);
  });

  it('no changedFilesHash prop → changedFilesHash absent from turnRecord', async () => {
    // When the git runner was unavailable the prop is undefined. The turnRecord must not
    // carry a hash in that case — the either-side rule conservatively skips the exemption.
    const task = verifiedTask();
    const ev = failedEval('correctness', { critique: 'needs work' });
    const result = await runEvaluatorTurnUseCase({
      task,
      priorTurns: [],
      plateauThreshold: 3,
      // changedFilesHash intentionally omitted
      callEvaluate: async () => Result.ok([ev] as readonly HarnessSignal[]),
      evaluationFile: EVAL_FILE,
      logger: noopLogger,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.turnRecord?.changedFilesHash).toBeUndefined();
  });

  it('changedFilesHash from props is threaded onto the turnRecord even on the warning path', async () => {
    // The warning path (soften) must also thread the hash — it reaches the hash assignment
    // in baseRecord before the verdict decision, so the record passed to the next turn is
    // always fingerprinted regardless of verdict kind.
    const task = verifiedTask();
    const ev = failedEval('correctness', { critique: 'placeholder' });
    const result = await runEvaluatorTurnUseCase({
      task,
      priorTurns: [priorTurnWith(ev, { changedFilesHash: HASH_A })],
      plateauThreshold: 2,
      changedFilesHash: HASH_B,
      callEvaluate: async () => Result.ok([ev] as readonly HarnessSignal[]),
      evaluationFile: EVAL_FILE,
      logger: noopLogger,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Warning path confirmed.
    expect(result.value.turnRecord?.verdict).toBe('warning');
    // Hash carried through.
    expect(result.value.turnRecord?.changedFilesHash).toBe(HASH_B);
  });
});
