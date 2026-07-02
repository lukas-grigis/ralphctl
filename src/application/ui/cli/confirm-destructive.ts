/**
 * Shared TTY-gated confirm guard for destructive one-shot CLI mutations (remove / delete).
 * Extracted from the pattern `runs prune` established: `-y, --yes` skips the prompt outright;
 * on a non-TTY stdin (CI, scripts, pipes) with no `--yes`, the action refuses rather than
 * hanging on a prompt nobody can answer; on a TTY, a plain y/N prompt gates the mutation.
 *
 * The CLI's destructive commands (`sprint remove`, `project remove`, `ticket remove`, `runs
 * prune`) all call the same repo-level mutation the TUI guards behind a `ConfirmCard` — this is
 * the CLI-side equivalent of that gate, so scripted/piped invocations can't skip it by accident.
 */

import { createInterface } from 'node:readline';

export interface ConfirmDestructiveOptions {
  /** `true` when `-y, --yes` was passed on the command line — skips the prompt entirely. */
  readonly yes: boolean;
  /** What's being skipped on refusal, e.g. `'remove project acme'` — no trailing punctuation. */
  readonly action: string;
  /** The y/N prompt text, e.g. `'remove project acme? [y/N] '`. */
  readonly confirmPrompt: string;
  /** Extra clause appended to the non-TTY refusal, e.g. `', or --dry-run to list candidates only'`. */
  readonly nonTtyHint?: string;
}

/**
 * Resolves `true` when the caller should proceed with the destructive mutation. On refusal or a
 * "no" answer this has already written the explanatory stderr/stdout line — the caller just
 * needs to bail without printing anything further.
 *
 * A non-TTY refusal sets `process.exitCode = 1` (it's a usage error — the caller ran
 * non-interactively without `--yes`). A plain "no" answer on a real TTY prompt leaves the exit
 * code at 0 — declining is a normal, successful cancellation, not a failure.
 */
export const confirmDestructive = async (opts: ConfirmDestructiveOptions): Promise<boolean> => {
  if (opts.yes) return true;
  if (process.stdin.isTTY !== true) {
    process.stderr.write(
      `error: refusing to ${opts.action} without confirmation on a non-TTY stdin — re-run with --yes to bypass${opts.nonTtyHint ?? ''}\n`
    );
    process.exitCode = 1;
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(opts.confirmPrompt, resolve);
    });
    const confirmed = isYes(answer.trim());
    if (!confirmed) process.stdout.write('aborted\n');
    return confirmed;
  } finally {
    rl.close();
  }
};

const isYes = (answer: string): boolean => {
  const lower = answer.toLowerCase();
  return lower === 'y' || lower === 'yes';
};
