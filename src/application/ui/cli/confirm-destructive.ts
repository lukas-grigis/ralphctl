/** Shared TTY-gated confirm guard for destructive one-shot CLI mutations (remove / delete). */

import { createInterface, type Interface } from 'node:readline';

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

/** Resolves `true` when the caller should proceed with the destructive mutation. */
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
    const answer = await askLine(rl, opts.confirmPrompt);
    if (answer === undefined) {
      process.stdout.write('aborted\n');
      process.exitCode = 130;
      return false;
    }
    const confirmed = isYes(answer.trim());
    if (!confirmed) process.stdout.write('aborted\n');
    return confirmed;
  } finally {
    rl.close();
  }
};

// A closed interface (Ctrl-C with no SIGINT listener, or Ctrl-D/EOF) never calls the question callback.
export const askLine = (rl: Interface, prompt: string): Promise<string | undefined> =>
  new Promise((resolve) => {
    rl.once('close', () => resolve(undefined));
    rl.question(prompt, resolve);
  });

export const isYes = (answer: string): boolean => {
  const lower = answer.toLowerCase();
  return lower === 'y' || lower === 'yes';
};
