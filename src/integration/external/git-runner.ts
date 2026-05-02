/**
 * `GitRunner` — minimal synchronous wrapper around `git` invocations.
 *
 * Pure-read git operations are synchronous (see
 * `src/integration/external/git.ts`) and the {@link ExternalPort} contract
 * keeps that shape: callers expect `boolean` / `string` / `string[]`
 * directly, not promises. Wrapping `spawnSync` behind this seam lets tests
 * substitute scripted responses without spawning real processes.
 *
 * The runner intentionally has no `git`-specific knowledge — it just runs
 * a binary with arguments in a cwd and returns the captured streams. The
 * higher-level `GitOperations` class translates argv lists into typed
 * results.
 */
import { spawnSync } from 'node:child_process';

import type { AbsolutePath } from '@src/domain/values/absolute-path.ts';

/** Default per-invocation timeout. Long enough for `git log` on big repos. */
const DEFAULT_GIT_TIMEOUT_MS = 30_000;

export interface GitRunnerOptions {
  readonly cwd: AbsolutePath;
  readonly args: readonly string[];
  /** Per-invocation override. Defaults to {@link DEFAULT_GIT_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

export interface GitRunnerResult {
  readonly stdout: string;
  readonly stderr: string;
  /**
   * Process exit code. `-1` indicates the process never produced an exit
   * status (typical for spawn errors — treat this the
   * same as a non-zero exit, so we surface a sentinel and let
   * `GitOperations` decide what to do).
   */
  readonly exitCode: number;
}

export interface GitRunner {
  run(opts: GitRunnerOptions): GitRunnerResult;
}

/**
 * Real implementation backed by `node:child_process.spawnSync`.
 *
 * No shell expansion — args are passed literally. The `git` binary is
 * resolved via `PATH` like any other CLI tool.
 */
export class NodeGitRunner implements GitRunner {
  run(opts: GitRunnerOptions): GitRunnerResult {
    const result = spawnSync('git', [...opts.args], {
      cwd: opts.cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: opts.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
    });

    // spawnSync surfaces process-spawn failure on `result.error`. Treat it
    // as a non-zero exit with the error message in stderr; pure-read ops
    // already swallow non-zero exits and return defaults.
    if (result.error) {
      return {
        stdout: typeof result.stdout === 'string' ? result.stdout : '',
        stderr: (typeof result.stderr === 'string' ? result.stderr : '') || result.error.message,
        exitCode: -1,
      };
    }

    return {
      stdout: typeof result.stdout === 'string' ? result.stdout : '',
      stderr: typeof result.stderr === 'string' ? result.stderr : '',
      exitCode: result.status ?? -1,
    };
  }
}
