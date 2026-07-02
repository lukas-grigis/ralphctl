import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { recordRunningAttemptVerification } from '@src/domain/entity/task-attempts.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import { RateLimitError } from '@src/domain/value/error/rate-limit-error.ts';
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

  it('recoverable evaluate failure (bad signals.json) self-blocks the task — does NOT propagate', async () => {
    // A non-Claude reviewer that never wrote a usable signals.json surfaces a domain error.
    // The turn must self-block so the task settles `blocked` (finalize maps self-blocked →
    // blockedReason → settle marks blocked) — NOT `malformed`, which settle treats as
    // done-with-warning and would mark an UNGRADED change `done`.
    const task = verifiedTask();
    const err = new InvalidStateError({
      entity: 'codex-provider',
      currentState: 'signals-missing',
      attemptedAction: 'complete evaluation',
      message: 'signals.json not found in outputDir',
    });
    const result = await runEvaluatorTurnUseCase({
      task,
      plateauThreshold: 2,
      callEvaluate: async () => Result.error(err),
      evaluationFile: EVAL_FILE,
      logger: noopLogger,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.exit?.kind).toBe('self-blocked');
      if (result.value.exit?.kind === 'self-blocked') {
        expect(result.value.exit.reason).toContain('evaluator did not produce a valid signals.json');
        expect(result.value.exit.reason).toContain('signals.json not found in outputDir');
      }
      expect(result.value.task).toBe(task); // unchanged — no evaluation recorded
    }
  });

  it('propagates an AbortError (user cancel) instead of self-blocking', async () => {
    const task = verifiedTask();
    const err = new AbortError({ elementName: 'codex-provider', reason: 'aborted by caller' });
    const result = await runEvaluatorTurnUseCase({
      task,
      plateauThreshold: 2,
      callEvaluate: async () => Result.error(err),
      evaluationFile: EVAL_FILE,
      logger: noopLogger,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(err);
  });

  it('propagates a RateLimitError (retries already exhausted) instead of self-blocking', async () => {
    const task = verifiedTask();
    const err = new RateLimitError({ subCode: 'spawn-stderr', message: 'rate-limit retries exhausted' });
    const result = await runEvaluatorTurnUseCase({
      task,
      plateauThreshold: 2,
      callEvaluate: async () => Result.error(err),
      evaluationFile: EVAL_FILE,
      logger: noopLogger,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(err);
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

  // Part 1(b): the FAIL verdict's `critique` is the loop's only error wire to the next generator
  // turn. When the reviewer leaves it empty, synthesize one from the failed dimensions' findings
  // so the loop never advances silently while per-dimension findings sit in the operator-only
  // evaluation.md sidecar.
  it('synthesizes a critique from failed-dimension findings when the evaluator left critique empty', async () => {
    const task = verifiedTask();
    const failed: EvaluationSignal = evaluation('failed', {
      dimensions: [
        { dimension: 'correctness', passed: false, finding: 'returns 500 on empty input at src/foo.ts:23' },
        { dimension: 'safety', passed: false, finding: 'unvalidated SQL at src/db.ts:9' },
        { dimension: 'completeness', passed: true, finding: '' },
      ],
      // No critique field — the reviewer emitted findings but no top-level critique.
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
      const critique = result.value.task.attempts.at(-1)?.critique ?? '';
      // Only the FAILED dimensions contribute, each tagged with its dimension name + finding.
      expect(critique).toContain('[correctness] returns 500 on empty input at src/foo.ts:23');
      expect(critique).toContain('[safety] unvalidated SQL at src/db.ts:9');
      // The passing dimension is not echoed into the critique.
      expect(critique).not.toContain('completeness');
    }
  });

  // PR #244 N/A dimensions: an `applicable: false` dimension (e.g. robustness on a change that
  // touches no error path) carries `passed: false` per the evaluator prompt's example, but it is
  // neither pass nor fail. It must NOT be folded into the synthesized critique as a fake failure —
  // otherwise the next generator turn is told to "fix" a non-issue and its boilerplate line skews
  // the trigram-Jaccard critique-shift comparison. Reuses the canonical `failedDimensions` guard.
  it('excludes an applicable:false (N/A) dimension from the synthesized critique', async () => {
    const task = verifiedTask();
    const failed: EvaluationSignal = evaluation('failed', {
      dimensions: [
        { dimension: 'correctness', passed: false, finding: 'returns 500 on empty input at src/foo.ts:23' },
        { dimension: 'robustness', passed: false, applicable: false, finding: 'no error path introduced' },
      ],
      // No critique field → synthesis path fires.
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
      const critique = result.value.task.attempts.at(-1)?.critique ?? '';
      expect(critique).toContain('[correctness] returns 500 on empty input at src/foo.ts:23');
      // The N/A dimension contributes neither its name nor its finding.
      expect(critique).not.toContain('robustness');
      expect(critique).not.toContain('no error path introduced');
    }
  });

  it('prefers the explicit critique over synthesis when the evaluator provided one', async () => {
    const task = verifiedTask();
    const failed: EvaluationSignal = evaluation('failed', {
      dimensions: [{ dimension: 'correctness', passed: false, finding: 'finding text not used' }],
      critique: 'explicit reviewer critique',
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
      expect(result.value.task.attempts.at(-1)?.critique).toBe('explicit reviewer critique');
    }
  });
});
