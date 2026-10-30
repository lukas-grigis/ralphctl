import { describe, expect, it } from 'vitest';
import {
  formatPreVerifyResults,
  formatRetryFeedback,
  lastSettledAttempt,
  runningAttempt,
  VERIFY_LOG_READ_MAX_BYTES,
  VERIFY_OUTPUT_MAX_CHARS,
  verifyRunForPhase,
} from '@src/application/flows/implement/leaves/_shared/verify-run-summary.ts';
import { appendAttemptVerifyRun } from '@src/domain/entity/task-attempts.ts';
import { completeAttempt, type VerifyRun } from '@src/domain/entity/attempt.ts';
import type { InProgressTask } from '@src/domain/entity/task.ts';
import type { Result } from '@src/domain/result.ts';
import { absolutePath, FIXED_LATER, FIXED_NOW, makeInProgressTaskWithRunningAttempt } from '@tests/fixtures/domain.ts';
import { composeVerifyBlocks } from '@src/application/flows/implement/leaves/generator.ts';

const unwrap = <T, E>(r: Result<T, E>): T => {
  if (!r.ok) throw new Error(`unwrap failed: ${String(r.error)}`);
  return r.value as T;
};

/**
 * `verify-run-summary` formats the harness verify-script audit rows into the two prompt blocks the
 * generator leaf inlines (T4): `<pre_verify_results>` from the running attempt's pre-verify, and
 * `<retry_feedback>` from the prior attempt's FAILING post-verify. Both stay pure — the caller
 * fetches the log best-effort and passes it in.
 */

const preRun = (overrides: Partial<VerifyRun> = {}): VerifyRun => ({
  phase: 'pre',
  ranAt: FIXED_NOW,
  command: 'pnpm verify',
  exitCode: 0,
  durationMs: 1200,
  outcome: 'success',
  ...overrides,
});

const postRun = (overrides: Partial<VerifyRun> = {}): VerifyRun => ({
  phase: 'post',
  ranAt: FIXED_LATER,
  command: 'pnpm verify',
  exitCode: 1,
  durationMs: 3400,
  outcome: 'failed',
  ...overrides,
});

/** Append a verify run onto the task's running attempt. */
const withRun = (task: InProgressTask, run: VerifyRun): InProgressTask => unwrap(appendAttemptVerifyRun(task, run));

/** Settle the current running attempt as `failed`, then open a fresh running attempt. */
const settleAndRetry = (task: InProgressTask): InProgressTask => {
  const last = task.attempts[task.attempts.length - 1];
  if (last === undefined || last.status !== 'running') throw new Error('expected a running attempt');
  const settled = completeAttempt(last, 'failed', FIXED_LATER);
  const attempts = [...task.attempts];
  attempts[attempts.length - 1] = settled;
  // Open attempt n+1 (running) so the task stays in_progress with a prior settled attempt.
  return {
    ...task,
    attempts: [...attempts, { n: settled.n + 1, startedAt: FIXED_LATER, status: 'running', finishedAt: null }],
  };
};

describe('runningAttempt / lastSettledAttempt', () => {
  it('returns the running last attempt and undefined for last-settled on a fresh task', () => {
    const task = makeInProgressTaskWithRunningAttempt();
    expect(runningAttempt(task)?.status).toBe('running');
    expect(lastSettledAttempt(task)).toBeUndefined();
  });

  it('after a failed attempt + retry, finds both the running and the prior settled attempt', () => {
    const task = settleAndRetry(makeInProgressTaskWithRunningAttempt());
    expect(runningAttempt(task)?.n).toBe(2);
    expect(lastSettledAttempt(task)?.n).toBe(1);
    expect(lastSettledAttempt(task)?.status).toBe('failed');
  });
});

describe('verifyRunForPhase', () => {
  it('finds the first run of the requested phase', () => {
    const task = withRun(withRun(makeInProgressTaskWithRunningAttempt(), preRun()), postRun());
    expect(verifyRunForPhase(runningAttempt(task), 'pre')?.phase).toBe('pre');
    expect(verifyRunForPhase(runningAttempt(task), 'post')?.phase).toBe('post');
  });

  it('returns undefined when the attempt or its runs are absent', () => {
    expect(verifyRunForPhase(undefined, 'pre')).toBeUndefined();
    expect(verifyRunForPhase(runningAttempt(makeInProgressTaskWithRunningAttempt()), 'pre')).toBeUndefined();
  });
});

describe('formatPreVerifyResults', () => {
  it('returns empty string when no pre-verify ran on the running attempt', () => {
    expect(formatPreVerifyResults(makeInProgressTaskWithRunningAttempt(), undefined)).toBe('');
  });

  it('renders the command, outcome, and duration for a green pre-verify', () => {
    const task = withRun(makeInProgressTaskWithRunningAttempt(), preRun());
    const out = formatPreVerifyResults(task, undefined);
    expect(out).toContain('command: `pnpm verify`');
    expect(out).toContain('passed (exit 0)');
    expect(out).toContain('duration: 1200ms');
  });

  it('renders FAILED with the exit code for a red pre-verify', () => {
    const task = withRun(makeInProgressTaskWithRunningAttempt(), preRun({ exitCode: 2, outcome: 'failed' }));
    const out = formatPreVerifyResults(task, undefined);
    expect(out).toContain('FAILED (exit 2)');
  });

  it('appends the log inside a fenced block when provided', () => {
    const task = withRun(makeInProgressTaskWithRunningAttempt(), preRun());
    const out = formatPreVerifyResults(task, '  some log output  ');
    expect(out).toContain('log:');
    expect(out).toContain('```');
    expect(out).toContain('some log output');
  });

  it('clamps an over-long log to its head and tail halves, marking how much of the middle was cut', () => {
    const task = withRun(makeInProgressTaskWithRunningAttempt(), preRun());
    // The first compiler error sits at the head and the failing summary at the tail; the middle goes.
    const pad = 'z'.repeat(VERIFY_OUTPUT_MAX_CHARS);
    const log = `HEAD_SENTINEL${pad}MIDDLE_SENTINEL${pad}TAIL_SENTINEL`;
    const fenced = (formatPreVerifyResults(task, log).split('```')[1] ?? '').trim();
    const [head, marker, tail] = fenced.split('\n');
    expect(head).toBe(log.slice(0, VERIFY_OUTPUT_MAX_CHARS / 2));
    expect(tail).toBe(log.slice(-VERIFY_OUTPUT_MAX_CHARS / 2));
    expect(marker).toBe(`…${String(log.length - VERIFY_OUTPUT_MAX_CHARS)} chars truncated…`);
    expect(fenced).toContain('HEAD_SENTINEL');
    expect(fenced).toContain('TAIL_SENTINEL');
    expect(fenced).not.toContain('MIDDLE_SENTINEL');
  });

  it('inlines a log at the cap untouched', () => {
    const task = withRun(makeInProgressTaskWithRunningAttempt(), preRun());
    const log = 'y'.repeat(VERIFY_OUTPUT_MAX_CHARS);
    expect(formatPreVerifyResults(task, log)).toContain(`\`\`\`\n${log}\n\`\`\``);
  });

  it('folds a skipped/synthetic row (empty command, no log) to empty string', () => {
    const task = withRun(
      makeInProgressTaskWithRunningAttempt(),
      preRun({ command: '', outcome: 'skipped', durationMs: 0 })
    );
    expect(formatPreVerifyResults(task, undefined)).toBe('');
  });

  it('still renders a synthetic row when a log is present', () => {
    const task = withRun(
      makeInProgressTaskWithRunningAttempt(),
      preRun({ command: '', outcome: 'success', durationMs: 0 })
    );
    const out = formatPreVerifyResults(task, 'baseline output');
    expect(out).toContain('baseline output');
  });
});

describe('formatRetryFeedback', () => {
  it('returns empty string on the first attempt (no prior settled attempt)', () => {
    const task = withRun(makeInProgressTaskWithRunningAttempt(), preRun());
    expect(formatRetryFeedback(task, undefined)).toBe('');
  });

  it('returns empty string when the prior attempt post-verify passed', () => {
    let task = withRun(makeInProgressTaskWithRunningAttempt(), postRun({ exitCode: 0, outcome: 'success' }));
    task = settleAndRetry(task);
    expect(formatRetryFeedback(task, undefined)).toBe('');
  });

  it('renders the failing prior post-verify command + outcome', () => {
    let task = withRun(makeInProgressTaskWithRunningAttempt(), postRun({ exitCode: 7 }));
    task = settleAndRetry(task);
    const out = formatRetryFeedback(task, 'regression trace');
    expect(out).toContain('command: `pnpm verify`');
    expect(out).toContain('FAILED (exit 7)');
    expect(out).toContain('regression trace');
  });
});

describe('composeVerifyBlocks', () => {
  it('reads far more of the log than it inlines, so the clamped head is the head of the log', async () => {
    const task = withRun(makeInProgressTaskWithRunningAttempt(), preRun({ exitCode: 2, outcome: 'failed' }));
    const log = `FIRST_ERROR${'z'.repeat(10 * VERIFY_OUTPUT_MAX_CHARS)}LAST_LINE`;
    const reads: Array<number | undefined> = [];
    const reader = (_path: unknown, maxBytes?: number): Promise<string> => {
      reads.push(maxBytes);
      return Promise.resolve(log);
    };
    const { preVerifyOutput } = await composeVerifyBlocks(reader, absolutePath('/tmp/sprint'), task.id, task);
    expect(reads).toEqual([VERIFY_LOG_READ_MAX_BYTES]);
    expect(preVerifyOutput).toContain('FIRST_ERROR');
    expect(preVerifyOutput).toContain('LAST_LINE');
  });

  describe('set-aside patch note in retry feedback', () => {
    const SPRINT = absolutePath('/tmp/sprint');
    /** Reader that only knows the given files; everything else is missing (`undefined`). */
    const readerOf =
      (files: Record<string, string>) =>
      (path: unknown): Promise<string | undefined> =>
        Promise.resolve(files[String(path)]);
    const patchFor = (task: InProgressTask, n: number): string =>
      `/tmp/sprint/logs/rejected-diff/${String(task.id)}/attempt-${String(n)}.patch`;

    it('names the prior attempt patch, framed as optional and unverified, when the file exists', async () => {
      const task = settleAndRetry(withRun(makeInProgressTaskWithRunningAttempt(), postRun()));
      const { retryFeedback } = await composeVerifyBlocks(
        readerOf({ [patchFor(task, 1)]: 'diff' }),
        SPRINT,
        task.id,
        task
      );
      expect(retryFeedback).toContain('FAILED (exit 1)');
      expect(retryFeedback).toContain('not in the working tree');
      expect(retryFeedback).toContain(`\`git apply ${patchFor(task, 1)}\``);
      expect(retryFeedback).toContain('unverified lead');
    });

    it('leaves the retry feedback byte-identical when no patch file exists', async () => {
      const task = settleAndRetry(withRun(makeInProgressTaskWithRunningAttempt(), postRun()));
      const { retryFeedback } = await composeVerifyBlocks(readerOf({}), SPRINT, task.id, task);
      expect(retryFeedback).toBe(formatRetryFeedback(task, undefined));
    });

    it('ignores a patch file for a different attempt number', async () => {
      const task = settleAndRetry(withRun(makeInProgressTaskWithRunningAttempt(), postRun()));
      const { retryFeedback } = await composeVerifyBlocks(
        readerOf({ [patchFor(task, 2)]: 'diff' }),
        SPRINT,
        task.id,
        task
      );
      expect(retryFeedback).not.toContain('set that attempt');
    });

    it('adds no note when the prior post-verify was green, even if a stale patch exists', async () => {
      const task = settleAndRetry(
        withRun(makeInProgressTaskWithRunningAttempt(), postRun({ exitCode: 0, outcome: 'success' }))
      );
      const { retryFeedback } = await composeVerifyBlocks(
        readerOf({ [patchFor(task, 1)]: 'diff' }),
        SPRINT,
        task.id,
        task
      );
      expect(retryFeedback).toBe('');
    });
  });
});
