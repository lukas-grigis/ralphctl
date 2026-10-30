import type { Attempt, VerifyRun, VerifyRunPhase } from '@src/domain/entity/attempt.ts';
import type { InProgressTask } from '@src/domain/entity/task.ts';

/**
 * Compact, prompt-safe formatters for the harness verify-script audit rows. The generator leaf
 * inlines two of these blocks:
 *
 *  - `<pre_verify_results>` — the CURRENT running attempt's `phase: 'pre'` row, so the generator
 *    reviews the baseline state instead of re-running the verify script in its turn.
 *  - `<retry_feedback>`     — the PREVIOUS attempt's failing `phase: 'post'` row, so a retry knows
 *    the regression it must fix first.
 *
 * Both blocks pair the structured `VerifyRun` metadata (command / exit / duration / outcome) with
 * a clamped excerpt of the on-disk log. Reading the log is the caller's job (best-effort IO at the
 * leaf boundary, capped at {@link VERIFY_LOG_READ_MAX_BYTES}); these helpers stay pure so they
 * unit-test without a filesystem — the block is environment context, not a full transcript.
 */

/** Max characters of command output inlined into a prompt block. Keeps the prompt addition bounded. */
export const VERIFY_OUTPUT_MAX_CHARS = 600;

/** How much of a verify log's end the caller reads, so the clamp's head is the log's own head for a typical run. */
export const VERIFY_LOG_READ_MAX_BYTES = 256 * 1024;

/**
 * Trimmed output, or its head and tail halves with the elided middle marked: the first compiler or
 * type error sits at the top of a log, the failing summary at the bottom. Half-and-half truncation
 * follows OpenAI's Codex prompting guide ("Tool Response Truncation").
 */
export const clampCommandOutput = (raw: string): string => {
  const trimmed = raw.trim();
  if (trimmed.length <= VERIFY_OUTPUT_MAX_CHARS) return trimmed;
  const half = VERIFY_OUTPUT_MAX_CHARS / 2;
  const elided = trimmed.length - VERIFY_OUTPUT_MAX_CHARS;
  return `${trimmed.slice(0, half)}\n…${String(elided)} chars truncated…\n${trimmed.slice(-half)}`;
};

/**
 * The running (last) attempt of an in-progress task, or undefined when there is none (defensive —
 * the gen-eval leaves always run with a running attempt present). Pure; no narrowing beyond the
 * status check the caller may rely on.
 */
export const runningAttempt = (task: InProgressTask): Attempt | undefined => {
  const last = task.attempts[task.attempts.length - 1];
  return last?.status === 'running' ? last : undefined;
};

/**
 * The most recent SETTLED (non-running) attempt of an in-progress task, or undefined on the first
 * attempt. Used to source the previous attempt's post-verify row for the retry-feedback block.
 */
export const lastSettledAttempt = (task: InProgressTask): Attempt | undefined =>
  [...task.attempts].reverse().find((a) => a.status !== 'running');

/** First `VerifyRun` of the given phase on an attempt, or undefined. */
export const verifyRunForPhase = (attempt: Attempt | undefined, phase: VerifyRunPhase): VerifyRun | undefined =>
  attempt?.verifyRuns?.find((r) => r.phase === phase);

const outcomeLabel = (run: VerifyRun): string => {
  switch (run.outcome) {
    case 'success':
      return 'passed (exit 0)';
    case 'failed':
      return `FAILED (exit ${String(run.exitCode)})`;
    case 'spawn-error':
      return 'could not spawn the verify command';
    case 'skipped':
      return 'no verify script configured';
  }
};

const formatVerifyRun = (run: VerifyRun, log: string | undefined): string => {
  const lines: string[] = [];
  if (run.command.length > 0) lines.push(`command: \`${run.command}\``);
  lines.push(`outcome: ${outcomeLabel(run)}`);
  if (run.durationMs > 0) lines.push(`duration: ${String(run.durationMs)}ms`);
  const clamped = clampCommandOutput(log ?? '');
  if (clamped.length > 0) {
    lines.push('');
    lines.push('log:');
    lines.push('```');
    lines.push(clamped);
    lines.push('```');
  }
  return lines.join('\n');
};

/**
 * Render the PRE_VERIFY_RESULTS block body from the running attempt's `phase: 'pre'` verify run.
 * Returns '' when no pre-verify ran on the running attempt (e.g. carried green baseline produced a
 * synthetic skipped/success row with an empty command and no log, or the attempt has no row yet) —
 * the renderer collapses the `<pre_verify_results>` placeholder cleanly. A skipped pre-verify with
 * no command carries no baseline information worth inlining, so it folds to ''.
 *
 * `logTail` is the (already best-effort fetched) tail of
 * `<sprintDir>/logs/verify/<taskId>/pre-attempt-<n>.log`; pass undefined when the log was absent or
 * unreadable.
 */
export const formatPreVerifyResults = (task: InProgressTask, logTail: string | undefined): string => {
  const run = verifyRunForPhase(runningAttempt(task), 'pre');
  if (run === undefined) return '';
  // A skipped/synthetic row with no command and no body carries nothing actionable.
  if (run.command.length === 0 && (logTail ?? '').trim().length === 0) return '';
  return formatVerifyRun(run, logTail);
};

/**
 * Render the RETRY_FEEDBACK block body from the previous SETTLED attempt's FAILING `phase: 'post'`
 * verify run. Returns '' when there is no prior attempt, the prior attempt has no post-verify row,
 * or that row did not fail (`exitCode === 0`) — the renderer collapses the `<retry_feedback>`
 * placeholder cleanly. A retry's prompt thus names the regression to fix first.
 *
 * `logTail` is the (already best-effort fetched) tail of
 * `<sprintDir>/logs/verify/<taskId>/post-attempt-<n>.log` for the PRIOR attempt; pass undefined
 * when absent or unreadable.
 */
export const formatRetryFeedback = (task: InProgressTask, logTail: string | undefined): string => {
  const run = verifyRunForPhase(lastSettledAttempt(task), 'post');
  if (run === undefined || run.exitCode === 0) return '';
  return formatVerifyRun(run, logTail);
};
