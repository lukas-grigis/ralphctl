import { spawn as nodeSpawn } from 'node:child_process';
import { Result } from '@src/domain/result.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
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
 *   - `Result.error(AbortError)` — the caller cancelled mid-run via `opts.signal` (Ctrl-C /
 *     TUI abort). The child process tree is killed promptly and the abort surfaces as the
 *     codebase's one transparently-propagated error rather than as a `passed: false` gate
 *     failure — a cancelled setup/verify is NOT a broken baseline. An already-aborted signal
 *     on entry short-circuits before any spawn. See CLAUDE.md "AbortError is the one error
 *     chains propagate transparently."
 */

export interface ShellScriptResult {
  readonly passed: boolean;
  readonly exitCode: number | null;
  readonly output: string;
  readonly durationMs: number;
}

export const DEFAULT_SHELL_TIMEOUT_MS = 5 * 60_000;
export const MAX_OUTPUT_BYTES = 50 * 1024 * 1024;

/**
 * SIGTERM → SIGKILL grace on the abort path. A setup/verify script that traps SIGTERM (e.g. a
 * shell wrapper with a `trap` handler) would otherwise outlive the abort and strand the run on a
 * resource a competitor may now own. After the abort's SIGTERM we schedule a hard SIGKILL once
 * this window elapses; the timer is cleared on a clean exit so it never fires a stray kill.
 * Mirrors the idle-watchdog's escalation ladder; kept local rather than imported to avoid an
 * integration-layer cross-sibling dependency (`io` → `ai/providers/_engine`).
 */
export const ABORT_KILL_GRACE_MS = 5_000;

export interface ShellScriptRunner {
  run(
    cwd: AbsolutePath,
    script: string,
    opts?: ShellRunOptions
  ): Promise<Result<ShellScriptResult, StorageError | AbortError>>;
}

export interface ShellRunOptions {
  readonly timeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Chain abort signal threaded from the leaf's `execute(input, signal)`. When it fires the
   * child process tree is killed (SIGTERM, same ladder as the timeout / cap kills) and the run
   * resolves `Result.error(AbortError)` instead of waiting out the timeout. An already-aborted
   * signal on entry short-circuits before spawning. Absent → no cancellation (today's behaviour).
   */
  readonly signal?: AbortSignal;
}

export interface ShellScriptRunnerDeps {
  readonly spawn?: Spawn;
  readonly defaultTimeoutMs?: number;
  readonly now?: () => number;
  /**
   * SIGTERM → SIGKILL grace on the abort path. Defaults to {@link ABORT_KILL_GRACE_MS}. Injectable
   * so tests can shorten the window instead of waiting out the real 5s ladder.
   */
  readonly abortKillGraceMs?: number;
}

export const createShellScriptRunner = (deps: ShellScriptRunnerDeps = {}): ShellScriptRunner => {
  const spawn = deps.spawn ?? defaultSpawn;
  const defaultTimeoutMs = deps.defaultTimeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS;
  const now = deps.now ?? Date.now;
  const abortKillGraceMs = deps.abortKillGraceMs ?? ABORT_KILL_GRACE_MS;

  const run = (
    cwd: AbsolutePath,
    script: string,
    opts: ShellRunOptions = {}
  ): Promise<Result<ShellScriptResult, StorageError | AbortError>> =>
    new Promise((resolve) => {
      const start = now();
      const timeoutMs = opts.timeoutMs ?? defaultTimeoutMs;

      // Already-aborted on entry: nothing spawned, resolve immediately as an abort so the
      // caller doesn't pay the spawn + timeout cost for a cancel that already happened.
      if (opts.signal?.aborted === true) {
        resolve(Result.error(new AbortError({ elementName: 'shell-script-runner', reason: 'shell script aborted' })));
        return;
      }

      let child;
      try {
        child = spawn(script, [], {
          stdio: ['pipe', 'pipe', 'pipe'],
          cwd: String(cwd),
          shell: true,
          detached: process.platform !== 'win32',
          // Non-interactive defaults for the spawned setup/verify child. These live on the CHILD
          // env only — ralphctl's own process env is untouched, so they never alter how the
          // harness itself detects CI / colour.
          //
          //   CI=true   — setup/verify scripts run headless (no TTY). pnpm 11 hardened its
          //     `node_modules` purge to ABORT without a TTY instead of re-creating it silently
          //     (`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`, pnpm/pnpm#9966 / #11562). On
          //     pnpm 11 EVERY `confirm-modules-purge=false` form is ignored at the abort site —
          //     verified against 11.1.3: the `npm_config_*` env, the `PNPM_CONFIG_*` env, and a
          //     local `.npmrc` all still abort; only `CI=true` (env) or
          //     `--config.confirm-modules-purge=false` (a CLI flag) suppress it. We run the
          //     user's script as an opaque shell string and cannot inject a flag into their
          //     `pnpm` invocation, so `CI=true` is the one lever available. It is also the honest
          //     signal — this IS an automated, non-interactive context. Set on BOTH setup and
          //     verify (both flow through this runner), so the two phases share one env and never
          //     drift on baseline. Caveat: JVM tests gated on
          //     `@DisabledIfEnvironmentVariable("CI")` skip — by design for automation, and
          //     symmetric across setup/verify. (This deliberately reverses the earlier
          //     "do NOT reach for CI=true" policy, which assumed a narrow pnpm flag would work —
          //     it does not on pnpm 11.)
          //
          //   PNPM_CONFIG_FROZEN_LOCKFILE=false   — `CI=true` also flips pnpm's `frozen-lockfile`
          //     default to true, which would fail a bare `pnpm install` on a drifted lockfile
          //     (`ERR_PNPM_OUTDATED_LOCKFILE`) — trading one abort for another. The pnpm-native
          //     `PNPM_CONFIG_` prefix IS honoured here (unlike the broken `npm_config_` form),
          //     so this restores the pre-CI install semantics: non-frozen, exactly as before.
          //
          //   NO_COLOR=1   — the cross-tool convention (https://no-color.org). Persisted
          //     setup/verify logs are plain text; without this they fill with `^[[1m…` escape
          //     sequences that render as garbage in editors. Honoured by Node / Python / Rust /
          //     Go / Ruby and modern CLIs; unknown to JVM tools (Maven / Gradle / sbt) — those
          //     are handled at script-authoring time via `mvn -B`, `gradle --console=plain`.
          //
          // Defaults sit BEFORE `...process.env` so a user can override any of them (e.g. export
          // `CI=` to opt out, `NO_COLOR=` / `FORCE_COLOR=1` for colour); `opts.env` wins last.
          env: {
            CI: 'true',
            PNPM_CONFIG_FROZEN_LOCKFILE: 'false',
            NO_COLOR: '1',
            ...process.env,
            ...opts.env,
          },
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

      const killTree = (sig: NodeJS.Signals): void => {
        if (process.platform !== 'win32' && typeof child.pid === 'number') {
          try {
            process.kill(-child.pid, sig);
            return;
          } catch {
            // group already gone — fall through to per-process kill.
          }
        }
        try {
          child.kill(sig);
        } catch {
          // already dead.
        }
      };

      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let timedOut = false;
      let capExceeded = false;
      let aborted = false;
      let settled = false;
      let killGraceTimer: NodeJS.Timeout | null = null;

      // Cancellation: when the chain's signal fires mid-run, kill the child tree (SIGTERM, same
      // ladder as the timeout / cap kills) and remember we aborted so the `close` handler resolves
      // an `AbortError` rather than a `passed: false` gate failure. `{ once: true }` so a settle
      // that races the abort doesn't leak the listener; we also remove it explicitly on settle.
      //
      // SIGTERM → SIGKILL escalation: a setup/verify script that traps SIGTERM would otherwise
      // outlive the abort and strand the run. After `ABORT_KILL_GRACE_MS` we send a hard SIGKILL;
      // `finish()` clears this timer so a child that exits cleanly within the window never gets a
      // stray kill. Mirrors the idle-watchdog's grace ladder.
      const onAbort = (): void => {
        if (settled) return;
        aborted = true;
        killTree('SIGTERM');
        killGraceTimer = setTimeout(() => {
          killTree('SIGKILL');
        }, abortKillGraceMs);
      };
      opts.signal?.addEventListener('abort', onAbort, { once: true });

      const appendChunk = (chunk: Buffer): void => {
        if (capExceeded) return;
        totalBytes += chunk.length;
        if (totalBytes > MAX_OUTPUT_BYTES) {
          capExceeded = true;
          killTree('SIGTERM');
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
        killTree('SIGTERM');
      }, timeoutMs);

      const finish = (exitCode: number | null, marker?: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // Clear the abort grace timer so a child that exited cleanly within the window doesn't
        // fire a stray SIGKILL at a recycled pid after we've resolved.
        if (killGraceTimer !== null) {
          clearTimeout(killGraceTimer);
          killGraceTimer = null;
        }
        opts.signal?.removeEventListener('abort', onAbort);
        // Abort wins over every other settle reason: a cancelled run is a user-initiated abort,
        // not a clean gate failure. Surface the codebase's transparently-propagated AbortError so
        // the chain tears down rather than treating the kill as a `passed: false` verify failure.
        if (aborted) {
          resolve(Result.error(new AbortError({ elementName: 'shell-script-runner', reason: 'shell script aborted' })));
          return;
        }
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
