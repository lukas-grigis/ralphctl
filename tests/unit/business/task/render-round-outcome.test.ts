import { describe, expect, it } from 'vitest';
import type { Attempt, FailedAttempt, VerifiedAttempt } from '@src/domain/entity/attempt.ts';
import type { CommitSha } from '@src/domain/value/commit-sha.ts';
import type { EvaluationSignal } from '@src/domain/signal.ts';
import { renderRoundOutcome } from '@src/business/task/render-round-outcome.ts';
import { FIXED_NOW, FIXED_LATER, isoTimestamp } from '@tests/fixtures/domain.ts';

const verifiedAttempt = (overrides: Partial<VerifiedAttempt> = {}): Attempt => ({
  n: 1,
  startedAt: FIXED_NOW,
  finishedAt: FIXED_LATER,
  status: 'verified',
  verification: {},
  ...overrides,
});

const failedAttempt = (overrides: Partial<FailedAttempt> = {}): Attempt => ({
  n: 1,
  startedAt: FIXED_NOW,
  finishedAt: FIXED_LATER,
  status: 'failed',
  ...overrides,
});

const passingEvaluation = (): EvaluationSignal => ({
  type: 'evaluation',
  status: 'passed',
  dimensions: [
    { dimension: 'correctness', passed: true, finding: 'ok' },
    { dimension: 'completeness', passed: true, finding: 'ok' },
  ],
  timestamp: FIXED_NOW,
});

const failingEvaluation = (): EvaluationSignal => ({
  type: 'evaluation',
  status: 'failed',
  dimensions: [
    { dimension: 'correctness', passed: true, finding: 'ok' },
    { dimension: 'completeness', passed: false, finding: 'missing edge case' },
  ],
  critique: 'Implementation misses the empty-input path.',
  timestamp: FIXED_NOW,
});

describe('renderRoundOutcome', () => {
  it('passed verdict: renders dimensions, omits the Critique section, synthesises a one-line summary with commit sha', () => {
    const out = renderRoundOutcome({
      roundN: 2,
      attemptN: 1,
      attempt: verifiedAttempt({ sessionId: 'sess-g', commitSha: 'abc1234deadbeef' as CommitSha }),
      verdict: 'passed',
      evaluation: passingEvaluation(),
      generatorSessionId: 'sess-g',
      durationMs: 5000,
    });

    expect(out).toContain('# Round 2 · attempt 1');
    expect(out).toContain('- generator session: sess-g');
    expect(out).toContain('- duration: 5s');
    expect(out).toContain('- verdict: passed');
    expect(out).toContain('- commit: abc1234deadbeef');
    expect(out).toContain('## Evaluator dimensions');
    expect(out).toContain('| correctness | PASS |');
    expect(out).toContain('| completeness | PASS |');
    expect(out).not.toContain('## Critique');
    expect(out).toContain('## Synthesis');
    expect(out).toMatch(/Round 2 of attempt 1 passed all evaluator dimensions and committed abc1234\./);
  });

  it('failed verdict: includes the Critique section as a blockquote and synthesises a failure summary', () => {
    const out = renderRoundOutcome({
      roundN: 1,
      attemptN: 1,
      attempt: failedAttempt({ critique: 'Implementation misses the empty-input path.' }),
      verdict: 'failed',
      evaluation: failingEvaluation(),
    });

    expect(out).toContain('- verdict: failed');
    expect(out).toContain('## Critique');
    expect(out).toContain('> Implementation misses the empty-input path.');
    expect(out).toMatch(/Round 1 of attempt 1 failed on completeness; critique persisted, round 2 will retry\./);
  });

  it('plateau verdict: synthesises a plateau summary using the failed dimension names', () => {
    const out = renderRoundOutcome({
      roundN: 3,
      attemptN: 2,
      attempt: failedAttempt({ n: 2 }),
      verdict: 'plateau',
      evaluation: {
        type: 'evaluation',
        status: 'failed',
        dimensions: [
          { dimension: 'correctness', passed: false, finding: 'still wrong' },
          { dimension: 'completeness', passed: false, finding: 'still missing' },
        ],
        timestamp: FIXED_NOW,
      },
    });

    expect(out).toContain('- verdict: plateau');
    expect(out).toMatch(/Round 3 of attempt 2 plateaued on correctness, completeness; harness gave up/);
  });

  it('renders em-dash for missing generator + evaluator session ids', () => {
    const out = renderRoundOutcome({
      roundN: 1,
      attemptN: 1,
      attempt: verifiedAttempt(),
      verdict: 'passed',
      evaluation: passingEvaluation(),
    });
    expect(out).toContain('- generator session: —');
    expect(out).toContain('- evaluator session: —');
  });

  it('renders em-dash for missing duration and missing commit', () => {
    const out = renderRoundOutcome({
      roundN: 1,
      attemptN: 1,
      attempt: failedAttempt(),
      verdict: 'failed',
      evaluation: failingEvaluation(),
    });
    expect(out).toContain('- duration: —');
    expect(out).toContain('- commit: —');
  });

  it('renders a deterministic output for identical inputs', () => {
    const input = {
      roundN: 1,
      attemptN: 1,
      attempt: verifiedAttempt({ sessionId: 'sess', commitSha: '1234567' as CommitSha }),
      verdict: 'passed' as const,
      evaluation: passingEvaluation(),
      generatorSessionId: 'sess',
      durationMs: 1500,
    };
    expect(renderRoundOutcome(input)).toBe(renderRoundOutcome(input));
  });

  it('uses critique fallback from the attempt when no evaluation signal provided', () => {
    const out = renderRoundOutcome({
      roundN: 1,
      attemptN: 1,
      attempt: failedAttempt({ critique: 'fallback critique text' }),
      verdict: 'failed',
    });
    expect(out).toContain('> fallback critique text');
  });

  it('handles missing critique on a failed round with a polite placeholder', () => {
    const out = renderRoundOutcome({
      roundN: 1,
      attemptN: 1,
      attempt: failedAttempt(),
      verdict: 'failed',
    });
    expect(out).toContain('## Critique');
    expect(out).toContain('_No critique text emitted by the evaluator._');
  });

  it('handles missing dimensions on a failed round (no signal) with a polite placeholder', () => {
    const out = renderRoundOutcome({
      roundN: 1,
      attemptN: 1,
      attempt: failedAttempt({
        evaluation: { status: 'failed', file: 'rounds/1/evaluator/evaluation.md' },
      }),
      verdict: 'failed',
    });
    expect(out).toContain('## Evaluator dimensions');
    expect(out).toContain('_No dimension verdicts recorded._');
  });

  it('avoids referencing 2026-05-08 explicitly — synthesis is deterministic over inputs only', () => {
    const out = renderRoundOutcome({
      roundN: 1,
      attemptN: 1,
      attempt: verifiedAttempt({ commitSha: 'abcdef1' as CommitSha }),
      verdict: 'passed',
      evaluation: passingEvaluation(),
    });
    expect(out).not.toContain(isoTimestamp('2026-05-08T10:00:00.000Z'));
  });
});
