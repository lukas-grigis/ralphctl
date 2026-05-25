import { spawn as nodeSpawn } from 'node:child_process';
import { Result } from '@src/domain/result.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { Spawn } from '@src/integration/io/spawn.ts';

/**
 * Run a project-configured shell script. Used by the implement chain leaves:
 *   - `setup-script-runner` (sprint-start environment prep)
 *   - `post-task-verify`    (verify the working tree after a commit)
 *
 * Scripts are user-configured in repository settings; they are not arbitrary AI-generated
 * commands. They run through a shell so user-friendly forms like `pnpm install && pnpm
 * typecheck` work without manual splitting.
 *
 * Output handling:
 *   - stdout + stderr are captured into a single combined buffer (consumers render them as
 *     one stream and order matters).
 *   - 50 MB hard cap on buffered output. Real verify scripts on big monorepos can legitimately
 *     emit several MB; the cap exists so a runaway loop can't OOM the harness. When the cap
 *     is hit the child is killed and a truncation marker is appended.
 *   - Default 5-minute timeout, override per-call. Timeouts also kill the child and append a
 *     marker.
 *
 * Result semantics:
 *   - `Result.ok({ passed, exitCode, output, durationMs })` — script ran. `passed` is
 *     `exitCode === 0`. Non-zero exit is *not* a system failure: the gate failed cleanly and
 *     the caller decides what to do.
 *   - `Result.error(StorageError)` — only for system-level failures (spawn fails because the
 *     shell binary is missing). Timeouts and cap-kills surface as `passed: false` with a
 *     marker, not as errors.
 */

export interface ShellScriptResult {
  readonly passed: boolean;
  readonly exitCode: number | null;
  readonly output: string;
  readonly durationMs: number;
}

export const DEFAULT_SHELL_TIMEOUT_MS = 5 * 60_000;
export const MAX_OUTPUT_BYTES = 50 * 1024 * 1024;

export interface ShellScriptRunner {
  run(cwd: AbsolutePath, script: string, opts?: ShellRunOptions): Promise<Result<ShellScriptResult, StorageError>>;
}

export interface ShellRunOptions {
  readonly timeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
}

export interface ShellScriptRunnerDeps {
  readonly spawn?: Spawn;
  readonly defaultTimeoutMs?: number;
  readonly now?: () => number;
}

export const createShellScriptRunner = (deps: ShellScriptRunnerDeps = {}): ShellScriptRunner => {
  const spawn = deps.spawn ?? defaultSpawn;
  const defaultTimeoutMs = deps.defaultTimeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS;
  const now = deps.now ?? Date.now;

  const run = (
    cwd: AbsolutePath,
    script: string,
    opts: ShellRunOptions = {}
  ): Promise<Result<ShellScriptResult, StorageError>> =>
    new Promise((resolve) => {
      const start = now();
      const timeoutMs = opts.timeoutMs ?? defaultTimeoutMs;
      let child;
      try {
        child = spawn(script, [], {
          stdio: ['pipe', 'pipe', 'pipe'],
          cwd: String(cwd),
          shell: true,
          detached: process.platform !== 'win32',
          // Narrow non-interactive defaults — applied per-tool so we don't silently change the
          // meaning of user-authored scripts. Setting blanket `CI=true` would trip
          // `@DisabledIfEnvironmentVariable("CI")` test skips in Spring Boot, change Maven
          // Surefire behaviour, and toggle countless other toolchain heuristics. Each entry
          // below is read by exactly one tool family:
          //
          //   npm_config_confirm_modules_purge=false   — pnpm only; suppresses the
          //     `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` prompt when pnpm decides to wipe
          //     `node_modules/` (lockfile / store mismatch). The same setting is also exposed
          //     as `.npmrc:confirm-modules-purge=false` and `--config.confirm-modules-purge=false`.
          //
          //   NO_COLOR=1   — the well-defined cross-tool convention (https://no-color.org)
          //     suppresses ANSI colour codes in tool output. The harness persists script
          //     output verbatim to `<sprintDir>/logs/{setup,verify}/...` plain-text files;
          //     without this default the logs fill with `^[[1m^[[30m…` escape sequences that
          //     render as garbage in editors. Honoured by Node / Python / Rust / Go / Ruby
          //     and modern CLI tools; tools that don't recognise it ignore it harmlessly.
          //     Exception: JVM tools (Maven / Gradle / sbt) do NOT respect `NO_COLOR` — those
          //     are handled at script-authoring time by the `detect-scripts` prompt suggesting
          //     `mvn -B`, `gradle --console=plain`, `sbt -no-colors`.
          //
          // Add more entries here as we hit narrow per-tool prompts; do NOT reach for `CI=true`.
          // Defaults sit BEFORE `...process.env` so a user who exports `NO_COLOR=` (empty) or
          // `FORCE_COLOR=1` can override; caller-supplied `opts.env` wins last.
          env: { npm_config_confirm_modules_purge: 'false', NO_COLOR: '1', ...process.env, ...opts.env },
        });
      } catch (cause) {
        resolve(
          Result.error(
            new StorageError({
              subCode: 'io',
              message: `failed to spawn shell script: ${stringifyError(cause)}`,
              cause,
            })
          )
        );
        return;
      }

      const killTree = (): void => {
        if (process.platform !== 'win32' && typeof child.pid === 'number') {
          try {
            process.kill(-child.pid, 'SIGTERM');
            return;
          } catch {
            // group already gone — fall through to per-process kill.
          }
        }
        try {
          child.kill('SIGTERM');
        } catch {
          // already dead.
        }
      };

      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let timedOut = false;
      let capExceeded = false;
      let settled = false;

      const appendChunk = (chunk: Buffer): void => {
        if (capExceeded) return;
        totalBytes += chunk.length;
        if (totalBytes > MAX_OUTPUT_BYTES) {
          capExceeded = true;
          killTree();
          return;
        }
        chunks.push(chunk);
      };

      child.stdout.on('data', (c: Buffer) => {
        appendChunk(c);
      });
      child.stderr.on('data', (c: Buffer) => {
        appendChunk(c);
      });

      const timer = setTimeout(() => {
        timedOut = true;
        killTree();
      }, timeoutMs);

      const finish = (exitCode: number | null, marker?: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const base = Buffer.concat(chunks).toString('utf8').trim();
        const output = marker !== undefined ? (base.length > 0 ? `${base}\n${marker}` : marker) : base;
        resolve(
          Result.ok({
            passed: exitCode === 0 && !timedOut && !capExceeded,
            exitCode,
            output,
            durationMs: now() - start,
          })
        );
      };

      child.on('error', (err) => {
        // Spawn-time error after the spawn() call returned (e.g. shell binary disappeared).
        // Surface as passed:false with a marker; callers treat this the same as exit 127.
        finish(null, `[spawn error: ${err.message}]`);
      });

      child.on('close', (code) => {
        if (timedOut) {
          finish(code, `[timeout exceeded after ${String(timeoutMs)}ms]`);
          return;
        }
        if (capExceeded) {
          finish(code, `[output exceeded ${String(MAX_OUTPUT_BYTES)} byte cap — truncated]`);
          return;
        }
        finish(code);
      });
    });

  return { run };
};

const defaultSpawn: Spawn = (command, args, options) =>
  nodeSpawn(command, [...args], { ...options, stdio: [...options.stdio] }) as ReturnType<Spawn>;

const stringifyError = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));
