import { describe, expect, it } from 'vitest';
import type { Attempt, FailedAttempt, RunningAttempt, VerifiedAttempt } from '@src/domain/entity/attempt.ts';
import {
  composeAttemptSummary,
  renderPriorAttemptsSection,
  selectKBestAttempts,
} from '@src/business/task/attempt-summary.ts';
import { FIXED_LATER, FIXED_NOW, commitSha } from '@tests/fixtures/domain.ts';

const SHA = commitSha(`1234567${'a'.repeat(33)}`);

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

const runningAttempt = (overrides: Partial<RunningAttempt> = {}): Attempt => ({
  n: 1,
  startedAt: FIXED_NOW,
  finishedAt: null,
  status: 'running',
  ...overrides,
});

describe('composeAttemptSummary', () => {
  it('renders only the header when no optional fields are set — no placeholders', () => {
    expect(composeAttemptSummary(verifiedAttempt({ n: 3 }))).toBe('Attempt 3: verified');
  });

  it('renders attribution when present', () => {
    const out = composeAttemptSummary(verifiedAttempt({ attribution: 'clean' }));
    expect(out).toBe('Attempt 1: verified\nattribution: clean');
  });

  it('omits critique when absent or whitespace-only', () => {
    expect(composeAttemptSummary(failedAttempt())).not.toContain('critique:');
    expect(composeAttemptSummary(failedAttempt({ critique: '   ' }))).not.toContain('critique:');
  });

  it('collapses whitespace in the critique excerpt', () => {
    const out = composeAttemptSummary(failedAttempt({ critique: 'Line one\n\n  Line two   trailing' }));
    expect(out).toContain('critique: Line one Line two trailing');
  });

  it('clamps the critique excerpt to 240 chars with an ellipsis', () => {
    const out = composeAttemptSummary(failedAttempt({ critique: 'A'.repeat(300) }));
    const critiqueLine = out.split('\n').find((l) => l.startsWith('critique:'));
    expect(critiqueLine).toBe(`critique: ${'A'.repeat(239)}…`);
  });

  it('renders a short (7-char) commit sha when commitSha is present', () => {
    const out = composeAttemptSummary(verifiedAttempt({ commitSha: SHA }));
    expect(out).toContain('commit: 1234567');
    expect(out).not.toContain(String(SHA));
  });

  it('renders a plateau warning with its failed dimensions', () => {
    const out = composeAttemptSummary(
      failedAttempt({ warning: { kind: 'plateau', dimensions: ['correctness', 'completeness'] } })
    );
    expect(out).toContain('warning: plateaued (correctness, completeness)');
  });

  it('renders a plateau warning without a dimensions parenthetical when the list is empty', () => {
    const out = composeAttemptSummary(failedAttempt({ warning: { kind: 'plateau', dimensions: [] } }));
    expect(out).toContain('warning: plateaued');
    expect(out).not.toContain('(');
  });

  it('renders a label for each non-plateau warning kind', () => {
    expect(
      composeAttemptSummary(failedAttempt({ warning: { kind: 'budget-exhausted', turnsUsed: 5, turnBudget: 10 } }))
    ).toContain('warning: turn budget exhausted');
    expect(composeAttemptSummary(failedAttempt({ warning: { kind: 'malformed', detail: 'bad json' } }))).toContain(
      'warning: evaluator output malformed'
    );
    expect(
      composeAttemptSummary(failedAttempt({ warning: { kind: 'verify-failed', exitCode: 1, stderr: 'boom' } }))
    ).toContain('warning: post-task verify failed');
    expect(composeAttemptSummary(failedAttempt({ warning: { kind: 'crashed', detail: 'sigkill' } }))).toContain(
      'warning: process crashed'
    );
  });

  it('renders the abort cause when present', () => {
    const out = composeAttemptSummary(failedAttempt({ status: 'aborted', abortCause: 'watchdog-killed' }));
    expect(out).toContain('abort cause: watchdog-killed');
  });

  it('orders fields: header, attribution, critique, commit, warning, abort cause', () => {
    const out = composeAttemptSummary(
      failedAttempt({
        status: 'aborted',
        attribution: 'regressed',
        critique: 'needs work',
        commitSha: SHA,
        warning: { kind: 'crashed', detail: 'sigkill' },
        abortCause: 'process-crash',
      })
    );
    expect(out.split('\n')).toEqual([
      'Attempt 1: aborted',
      'attribution: regressed',
      'critique: needs work',
      'commit: 1234567',
      'warning: process crashed',
      'abort cause: process-crash',
    ]);
  });

  it('renders a running attempt without throwing (caller-level exclusion, not this function)', () => {
    expect(composeAttemptSummary(runningAttempt({ n: 2 }))).toBe('Attempt 2: running');
  });
});

describe('selectKBestAttempts', () => {
  it('excludes running attempts', () => {
    const attempts = [verifiedAttempt({ n: 1, attribution: 'clean' }), runningAttempt({ n: 2 })];
    const selected = selectKBestAttempts(attempts, 5);
    expect(selected).toHaveLength(1);
    expect(selected[0]?.n).toBe(1);
  });

  it('returns [] for an empty input', () => {
    expect(selectKBestAttempts([], 3)).toEqual([]);
  });

  it('returns [] when every attempt is still running', () => {
    expect(selectKBestAttempts([runningAttempt({ n: 1 }), runningAttempt({ n: 2 })], 3)).toEqual([]);
  });

  it('returns [] when k is 0 or negative', () => {
    const attempts = [verifiedAttempt({ n: 1 })];
    expect(selectKBestAttempts(attempts, 0)).toEqual([]);
    expect(selectKBestAttempts(attempts, -1)).toEqual([]);
  });

  it('ranks clean and fixed-baseline attribution above baseline-broken above regressed', () => {
    const attempts = [
      failedAttempt({ n: 2, status: 'failed', attribution: 'regressed' }),
      verifiedAttempt({ n: 3, attribution: 'baseline-broken' }),
      failedAttempt({ n: 4, status: 'malformed', attribution: 'fixed-baseline' }),
      verifiedAttempt({ n: 1, attribution: 'clean' }),
      failedAttempt({ n: 5, status: 'aborted' }),
    ];
    // top 3 by score: n1 (clean, verified), n4 (fixed-baseline, malformed), n5 (unknown, aborted)
    const selected = selectKBestAttempts(attempts, 3);
    expect(selected.map((a) => a.n)).toEqual([1, 4, 5]);
  });

  it('ranks unknown attribution between baseline-broken and regressed', () => {
    const attempts = [
      verifiedAttempt({ n: 1 }), // score 22 (attribution absent → unknown)
      verifiedAttempt({ n: 2, attribution: 'baseline-broken' }), // score 12
      verifiedAttempt({ n: 3, attribution: 'regressed' }), // score 2
    ];
    // k=2 keeps the two highest-scoring (n1, n2), drops the lowest (n3)
    const selected = selectKBestAttempts(attempts, 2);
    expect(selected.map((a) => a.n)).toEqual([1, 2]);
  });

  it('lets attribution dominate status — a clean-but-aborted attempt outranks a regressed-but-verified one', () => {
    const attempts = [
      verifiedAttempt({ n: 10, attribution: 'regressed' }), // score 0*10+2 = 2
      failedAttempt({ n: 20, status: 'aborted', attribution: 'clean' }), // score 3*10+0 = 30
    ];
    const selected = selectKBestAttempts(attempts, 1);
    expect(selected.map((a) => a.n)).toEqual([20]);
  });

  it('tie-breaks equal scores to the newest attempt', () => {
    const attempts = [
      verifiedAttempt({ n: 1, attribution: 'clean' }),
      verifiedAttempt({ n: 4, attribution: 'clean' }),
      failedAttempt({ n: 2, attribution: 'regressed' }),
    ];
    const selected = selectKBestAttempts(attempts, 1);
    expect(selected.map((a) => a.n)).toEqual([4]);
  });

  it('returns selected attempts in chronological (oldest-first) order regardless of rank order', () => {
    const attempts = [
      verifiedAttempt({ n: 5, attribution: 'clean' }), // highest score, latest n
      verifiedAttempt({ n: 1, attribution: 'baseline-broken' }),
      verifiedAttempt({ n: 3, attribution: 'clean' }),
    ];
    const selected = selectKBestAttempts(attempts, 3);
    expect(selected.map((a) => a.n)).toEqual([1, 3, 5]);
  });

  it('returns all settled attempts, chronologically, when k exceeds the settled count', () => {
    const attempts = [
      verifiedAttempt({ n: 2, attribution: 'clean' }),
      runningAttempt({ n: 3 }),
      failedAttempt({ n: 1, attribution: 'regressed' }),
    ];
    const selected = selectKBestAttempts(attempts, 10);
    expect(selected.map((a) => a.n)).toEqual([1, 2]);
  });
});

describe('renderPriorAttemptsSection', () => {
  it('returns "" for an empty attempt list', () => {
    expect(renderPriorAttemptsSection([])).toBe('');
  });

  it('returns "" when every attempt is still running', () => {
    expect(renderPriorAttemptsSection([runningAttempt({ n: 1 })])).toBe('');
  });

  it('renders a header line followed by the selected attempt summaries', () => {
    const attempts = [
      verifiedAttempt({ n: 1, attribution: 'clean' }),
      failedAttempt({ n: 2, attribution: 'regressed' }),
    ];
    const out = renderPriorAttemptsSection(attempts);
    const blocks = out.split('\n\n');
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toContain('prior attempts');
    expect(blocks[1]).toBe('Attempt 1: verified\nattribution: clean');
    expect(blocks[2]).toBe('Attempt 2: failed\nattribution: regressed');
  });

  it('defaults to selecting 3 attempts', () => {
    const attempts = Array.from({ length: 5 }, (_, i) => verifiedAttempt({ n: i + 1, attribution: 'clean' }));
    const out = renderPriorAttemptsSection(attempts);
    // header + 3 attempt blocks
    expect(out.split('\n\n')).toHaveLength(4);
  });

  it('honours a custom k', () => {
    const attempts = Array.from({ length: 5 }, (_, i) => verifiedAttempt({ n: i + 1, attribution: 'clean' }));
    const out = renderPriorAttemptsSection(attempts, { k: 2 });
    expect(out.split('\n\n')).toHaveLength(3);
  });

  it('bounds the whole section to ~2400 chars', () => {
    const attempts = Array.from({ length: 10 }, (_, i) =>
      verifiedAttempt({ n: i + 1, attribution: 'clean', critique: 'B'.repeat(230) })
    );
    const out = renderPriorAttemptsSection(attempts, { k: 10 });
    expect(out.length).toBe(2400);
    expect(out.endsWith('…')).toBe(true);
  });
});
