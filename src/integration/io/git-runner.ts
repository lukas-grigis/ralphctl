import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { Result } from '@src/domain/result.ts';
import { messageOf } from '@src/domain/value/error/error-message.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { Spawn } from '@src/integration/io/spawn.ts';
import { pipeSpawn } from '@src/integration/io/cross-platform-spawn.ts';
import { killWithEscalation } from '@src/integration/io/kill-with-escalation.ts';
import { markProcessGroupLeader, supportsProcessGroups } from '@src/integration/io/kill-process-tree.ts';
import { onChildDone } from '@src/integration/io/child-exit.ts';

/**
 * Async wrapper around `git` invocations. Pure transport: no shell expansion, no
 * git-specific knowledge. Higher-level operations (`git-operations.ts`) translate argv lists
 * into typed results.
 *
 * Result semantics:
 *   - `Result.ok({ stdout, stderr, exitCode })` whenever git completed (zero or non-zero).
 *     Callers decide what a non-zero exit means in context.
 *   - `Result.error(StorageError({ subCode: 'io' }))` for system-level failures: spawn
 *     errors, timeouts, killed processes. Pure-read git ops in `git-operations.ts` typically
 *     map these back to safe defaults.
 *
 * No shell — args go through argv, so quotes / `$` / backticks / newlines are preserved
 * verbatim without expansion.
 *
 * Every git child leads its own process group (POSIX), so a timeout or abort also reaps the hooks
 * it runs, and it has no controlling terminal — together with `GIT_TERMINAL_PROMPT=0` that makes a
 * missing credential or an SSH passphrase fail fast instead of prompting on the TUI's terminal.
 */

export const DEFAULT_GIT_TIMEOUT_MS = 30_000;

/** Verbs that run user hooks or touch the network (commit, push, checkout, merge, cherry-pick, worktree add). */
export const GIT_HOOK_TIMEOUT_MS = 10 * 60_000;

/** Verbs that walk or delete a whole working tree but run no hooks (stash push -u, worktree remove --force). */
export const GIT_BULK_TIMEOUT_MS = 2 * 60_000;

/**
 * Hard cap on buffered git command output. Git command output — notably `git diff HEAD` for the
 * work-product fingerprint — is capped so a huge AI-generated diff can't OOM the heap; mirrors
 * shell-script-runner's `MAX_OUTPUT_BYTES`. Once stdout exceeds this ceiling the child is killed
 * and a truncation marker is appended; callers degrade gracefully (the fingerprint hashes the
 * truncated diff deterministically — an exemption input, never a correctness gate).
 */
export const GIT_MAX_OUTPUT_BYTES = 50 * 1024 * 1024;

export interface GitRunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface GitRunOptions {
  readonly timeoutMs?: number;
  /** Kills git and its hooks and settles with an error, so a long hook budget never blocks a cancel. */
  readonly signal?: AbortSignal;
}

export interface GitRunner {
  run(cwd: AbsolutePath, args: readonly string[], opts?: GitRunOptions): Promise<Result<GitRunResult, StorageError>>;
}

export interface GitRunnerDeps {
  readonly spawn?: Spawn;
  readonly defaultTimeoutMs?: number;
  /**
   * Output-buffer cap. Defaults to {@link GIT_MAX_OUTPUT_BYTES}. Injectable so tests can drive a
   * tiny cap instead of generating 50 MB of fake stdout.
   */
  readonly maxOutputBytes?: number;
}

// Only the real spawn marks its child: an injected fake's made-up pid must never be group-killed.
const defaultSpawn: Spawn = (command, args, options) => {
  const child = pipeSpawn(command, args, options);
  if (options.detached === true) markProcessGroupLeader(child);
  return child;
};

export const createGitRunner = (deps: GitRunnerDeps = {}): GitRunner => {
  const spawn = deps.spawn ?? defaultSpawn;
  const defaultTimeoutMs = deps.defaultTimeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  const maxOutputBytes = deps.maxOutputBytes ?? GIT_MAX_OUTPUT_BYTES;

  const run = (
    cwd: AbsolutePath,
    args: readonly string[],
    opts: GitRunOptions = {}
  ): Promise<Result<GitRunResult, StorageError>> =>
    runGitOnce(spawn, cwd, args, opts.timeoutMs ?? defaultTimeoutMs, maxOutputBytes, opts.signal);

  return { run };
};

/** Spawns the `git` child, mapping a synchronous spawn throw to a `StorageError`. */
const spawnGitChild = (
  spawn: Spawn,
  cwd: AbsolutePath,
  args: readonly string[]
): Result<ChildProcessWithoutNullStreams, StorageError> => {
  try {
    return Result.ok(
      spawn('git', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: String(cwd),
        detached: supportsProcessGroups(),
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      })
    );
  } catch (cause) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `failed to spawn git: ${messageOf(cause)}`,
        cause,
      })
    );
  }
};

interface OutputCollector {
  /** Buffers a stdout chunk. Returns `true` the instant the cap trips, so the caller — which
   * owns the child process — can kill it; further chunks are dropped once truncated. */
  readonly appendStdout: (chunk: Buffer) => boolean;
  readonly appendStderr: (chunk: Buffer) => void;
  readonly isTruncated: () => boolean;
  readonly stdoutText: () => string;
  readonly stderrText: () => string;
}

/**
 * Buffers stdout/stderr up to `maxOutputBytes`. Mirrors shell-script-runner's byte-cap
 * bookkeeping so a huge AI-generated diff can't OOM the heap.
 */
const createOutputCollector = (maxOutputBytes: number): OutputCollector => {
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let truncated = false;

  const appendStdout = (chunk: Buffer): boolean => {
    if (truncated) return false;
    stdoutBytes += chunk.length;
    if (stdoutBytes > maxOutputBytes) {
      truncated = true;
      return true;
    }
    stdoutChunks.push(chunk);
    return false;
  };

  // stderr is tiny in practice; cap it too for consistency. No marker is emitted for stderr.
  const appendStderr = (chunk: Buffer): void => {
    if (stderrBytes > maxOutputBytes) return;
    stderrBytes += chunk.length;
    if (stderrBytes > maxOutputBytes) return;
    stderrChunks.push(chunk);
  };

  return {
    appendStdout,
    appendStderr,
    isTruncated: () => truncated,
    stdoutText: () => Buffer.concat(stdoutChunks).toString('utf8'),
    stderrText: () => Buffer.concat(stderrChunks).toString('utf8'),
  };
};

/**
 * Translates git's exit into the final `Result`. A timeout / abort kill (`killedBy`) takes
 * precedence (cap-kills are tracked separately via `collector.isTruncated()` so they never
 * masquerade as a timeout). Materializing stdout can throw `ERR_STRING_TOO_LONG` when output
 * exceeds V8's max string length (~512MiB — e.g. a `git diff HEAD` over enormous generated
 * artifacts); this runs outside any caller try/catch, so the throw is caught here and mapped to a
 * `StorageError` instead of killing the process.
 */
const buildCloseResult = (
  collector: OutputCollector,
  killedBy: string | undefined,
  code: number | null,
  args: readonly string[],
  maxOutputBytes: number
): Result<GitRunResult, StorageError> => {
  if (killedBy !== undefined) {
    return Result.error(new StorageError({ subCode: 'io', message: `git ${killedBy}: git ${args.join(' ')}` }));
  }
  try {
    const base = collector.stdoutText();
    const stdout = collector.isTruncated()
      ? `${base}\n[git output exceeded ${String(maxOutputBytes)} byte cap — truncated]`
      : base;
    return Result.ok({
      stdout,
      stderr: collector.stderrText(),
      exitCode: code ?? -1,
    });
  } catch (cause) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `git output too large to materialize: git ${args.join(' ')} — ${messageOf(cause)}`,
      })
    );
  }
};

/**
 * Run git and treat any non-zero exit as a `git <label> failed: <stderr||stdout>` StorageError —
 * for the many operations where a non-zero exit carries no meaning beyond failure.
 */
export const runGitChecked = async (
  runner: GitRunner,
  cwd: AbsolutePath,
  args: readonly string[],
  label: string,
  opts?: GitRunOptions
): Promise<Result<GitRunResult, StorageError>> => {
  const result = opts === undefined ? await runner.run(cwd, args) : await runner.run(cwd, args, opts);
  if (!result.ok) return result;
  if (result.value.exitCode !== 0) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `git ${label} failed: ${(result.value.stderr || result.value.stdout).trim()}`,
      })
    );
  }
  return result;
};

const abortedError = (args: readonly string[]): StorageError =>
  new StorageError({ subCode: 'io', message: `git aborted: git ${args.join(' ')}` });

const runGitOnce = (
  spawn: Spawn,
  cwd: AbsolutePath,
  args: readonly string[],
  timeoutMs: number,
  maxOutputBytes: number,
  signal: AbortSignal | undefined
): Promise<Result<GitRunResult, StorageError>> =>
  new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve(Result.error(abortedError(args)));
      return;
    }
    const spawnResult = spawnGitChild(spawn, cwd, args);
    if (!spawnResult.ok) {
      resolve(Result.error(spawnResult.error));
      return;
    }
    const child = spawnResult.value;

    const collector = createOutputCollector(maxOutputBytes);
    let killedBy: string | undefined;
    let exited = false;
    let settled = false;

    // SIGTERM → grace → SIGKILL to git's whole group, so a hook dies with it and a wedged git can't
    // hold `.git/index.lock` forever. The run settles once git has exited, never before.
    const kill = (reason?: string): void => {
      if (exited) return;
      killedBy ??= reason;
      killWithEscalation(child);
    };

    // Drop further chunks once the cap is hit and kill the child so git stops producing more
    // (mirrors shell-script-runner); the exit is reported as cap-truncation, not a timeout.
    child.stdout.on('data', (c: Buffer) => {
      if (collector.appendStdout(c)) kill();
    });
    child.stderr.on('data', (c: Buffer) => collector.appendStderr(c));

    const timer = setTimeout(() => {
      kill(`timed out after ${String(timeoutMs)}ms`);
    }, timeoutMs);
    const onAbort = (): void => {
      kill('aborted');
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    // Once git has exited its work is done; a timer firing during the output drain is no timeout.
    child.once('exit', () => {
      exited = true;
      clearTimeout(timer);
    });

    const finish = (result: Result<GitRunResult, StorageError>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };

    child.on('error', (err) => {
      finish(
        Result.error(
          new StorageError({
            subCode: 'io',
            message: `git spawn error: ${err.message}`,
            cause: err,
          })
        )
      );
    });

    onChildDone(child, (code) => {
      finish(buildCloseResult(collector, killedBy, code, args, maxOutputBytes));
    });
  });
