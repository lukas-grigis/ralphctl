/**
 * `FakeGitRunner` — scripted fake of {@link GitRunner} used by
 * `git-operations` and `external-adapter` tests so they don't have to
 * spawn a real `git` binary. Captures every invocation for assertions
 * and returns the next scripted response (or a sensible default when
 * the script is exhausted).
 */
import type { GitRunner, GitRunnerOptions, GitRunnerResult } from '../external/git-runner.ts';

/** Capture of a single `run` call. */
export interface CapturedGitCall {
  readonly cwd: string;
  readonly args: readonly string[];
}

/** Predicate-based response — fires when `argMatches([…args])` is true. */
export interface ScriptedGitResponse {
  readonly match: (args: readonly string[]) => boolean;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
}

const DEFAULT_RESULT: GitRunnerResult = {
  stdout: '',
  stderr: '',
  exitCode: 0,
};

export class FakeGitRunner implements GitRunner {
  readonly calls: CapturedGitCall[] = [];

  /** Keyed responses tried in registration order until one matches. */
  private readonly responses: ScriptedGitResponse[] = [];

  /** FIFO queue used when no `responses` predicate matches. */
  private readonly fallbackQueue: GitRunnerResult[] = [];

  /** Register a predicate-based response. */
  on(
    match: (args: readonly string[]) => boolean,
    response: { stdout?: string; stderr?: string; exitCode?: number }
  ): this {
    this.responses.push({ match, ...response });
    return this;
  }

  /**
   * Convenience: match by argv prefix (e.g. `['status', '--porcelain']`).
   * Useful when the exact tail varies (paths, SHAs, …).
   */
  onArgsStartingWith(
    prefix: readonly string[],
    response: { stdout?: string; stderr?: string; exitCode?: number }
  ): this {
    return this.on((args) => args.length >= prefix.length && prefix.every((seg, i) => args[i] === seg), response);
  }

  /** Push a non-predicate fallback response onto the FIFO queue. */
  enqueue(response: { stdout?: string; stderr?: string; exitCode?: number }): this {
    this.fallbackQueue.push({
      stdout: response.stdout ?? '',
      stderr: response.stderr ?? '',
      exitCode: response.exitCode ?? 0,
    });
    return this;
  }

  run(opts: GitRunnerOptions): GitRunnerResult {
    this.calls.push({ cwd: opts.cwd, args: [...opts.args] });
    for (const r of this.responses) {
      if (r.match(opts.args)) {
        return {
          stdout: r.stdout ?? '',
          stderr: r.stderr ?? '',
          exitCode: r.exitCode ?? 0,
        };
      }
    }
    return this.fallbackQueue.shift() ?? DEFAULT_RESULT;
  }

  /** Convenience: most recent captured invocation, or undefined. */
  lastCall(): CapturedGitCall | undefined {
    return this.calls.at(-1);
  }
}
