import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { Result } from '@src/domain/result.ts';
import type { HeadlessAiProvider, ProviderOutput } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import type { SessionPermissions } from '@src/integration/ai/providers/_engine/session-permissions.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { RateLimitError } from '@src/domain/value/error/rate-limit-error.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { parseHarnessSignals } from '@src/integration/ai/signals/_engine/parse-signals.ts';
import { isClaudeModel } from '@src/domain/value/settings-models/claude.ts';
import { parseClaudeJsonEnvelope } from '@src/integration/ai/providers/claude/parse-stream.ts';
import type { ProviderSpawn } from '@src/integration/ai/providers/_engine/spawn.ts';
import { runHeadlessSpawn } from '@src/integration/ai/providers/_engine/run-headless-spawn.ts';
import {
  DEFAULT_BACKOFF_SCHEDULE,
  delayForRetry,
  sleepCancellable,
} from '@src/integration/ai/providers/_engine/rate-limit-backoff.ts';
import { writeJsonAtomic, writeTextAtomic } from '@src/integration/io/fs.ts';

/**
 * Real {@link HeadlessAiProvider} backed by the Claude Code CLI.
 *
 * Output handling — file-based contract: claude is invoked with `-p --output-format json`,
 * which emits ONE JSON envelope to stdout: `{"session_id":"…","result":"<assistant text>",…}`.
 * After `'close'` fires (stdio drained), the captured stdout is JSON.parse'd, the `result`
 * body is fed to {@link parseHarnessSignals}, and the parsed signal array is written to
 * `session.signalsFile`. The body itself is dropped — it never leaves this function. When
 * `session.bodyFile` is set (one-shot flows that extract custom tags outside the harness-signal
 * registry), the body is also written there for the caller to read inline.
 *
 * Rate-limit detection is a lean stderr regex (`/rate.?limit/i`); on match, retry up to
 * `rateLimitRetries` then surface {@link RateLimitError}. `abortSignal` propagates to SIGTERM
 * — the harness only kills the child when the user cancels; there is no wall-clock timeout
 * because an implement session can legitimately run for hours.
 *
 * Translation table (intent → Claude CLI flag):
 *
 *   | AiSession field                                         | Claude flag                                                  |
 *   | ------------------------------------------------------- | ------------------------------------------------------------ |
 *   | model: <ClaudeModel>                                    | --model <model>                                              |
 *   | permissions {autoApprove,canEditFiles,canRunShell}=true | --permission-mode bypassPermissions                          |
 *   | permissions read-only (canEditFiles=false, …)           | --permission-mode bypassPermissions --disallowedTools <list> |
 *   | additionalRoots: [a, b]                                 | --add-dir a --add-dir b                                      |
 *   | resume: id                                              | --resume id                                                  |
 *
 * Test seam: `spawn` is overridable so tests script stdout / stderr / exit code without
 * actually launching `claude`. Defaults to `node:child_process.spawn`.
 *
 * Docs: https://code.claude.com/docs/en/cli-reference (`--model`, `--add-dir`,
 * `--permission-mode`, `--output-format`, `--resume`).
 */
export interface ClaudeProviderDeps {
  /** Adapter-side retries on `RateLimitError` before surfacing the failure. */
  readonly rateLimitRetries: number;
  /** Sink for adapter-level logs (session id capture, retries, raw lines at debug level). */
  readonly eventBus: EventBus;
  /** Test seam: defaults to `node:child_process.spawn`. */
  readonly spawn?: ProviderSpawn;
  /**
   * Test seam: overrides the executable name. Defaults to `'claude'` so the binary must be on
   * `$PATH` (vendoring is a follow-up — see decision log).
   */
  readonly command?: string;
  /**
   * Milliseconds of stdio silence before the adapter SIGTERMs a wedged child. Defaults to
   * {@link DEFAULT_IDLE_MS} (5 min). Real sessions stream tokens continuously; this only fires
   * on truly stuck children. Surface as an opt-in to keep tests fast (lower the threshold to
   * a few ms to exercise the watchdog path).
   */
  readonly idleMs?: number;
  /**
   * Wait schedule between rate-limit retries, in ms. Defaults to
   * {@link DEFAULT_BACKOFF_SCHEDULE} (1 min → 5 min → 30 min → 2 h). Tests pass `[0, 0, …]`
   * to keep retry assertions fast.
   */
  readonly backoffSchedule?: readonly number[];
}

const RATE_LIMIT_RE = /rate.?limit/i;

/**
 * Headless permission mapping. Every session uses `--permission-mode bypassPermissions` paired
 * with a `--disallowedTools` deny list scoped to whichever permissions are off.
 *
 *  - **Read-only chains** (refine / plan / readiness / detect-scripts / detect-skills) used to
 *    map to `--permission-mode plan`. Recent Claude Code versions tightened plan mode so it
 *    requires interactive approval for *every* tool — including reads — and the model emits a
 *    human-facing "please grant read permission" message instead of using its Read tool. In
 *    headless `-p` mode there's no human to answer the prompt, so the chain falls through with
 *    no signals and the operator sees an empty proposal. Switching read-only flows to
 *    `bypassPermissions + disallowedTools` lets reads sail through while writes / shell stay
 *    blocked — Claude's deny rules take precedence over `bypassPermissions`.
 *  - **Full-auto chains** (implement / apply-feedback) still need `bypassPermissions` because
 *    `acceptEdits` only auto-approves Read/Write/Edit and prompts for `Bash`, which hangs
 *    `claude -p` forever waiting on stdin. Safety is enforced at the branch / dirty-tree /
 *    post-task-check layer, not at the per-tool prompt.
 *
 * Docs: https://code.claude.com/docs/en/agent-sdk/permissions
 *  - bypassPermissions auto-approves every tool; `allowedTools` does NOT constrain it.
 *  - `disallowedTools` is a deny rule that overrides every other allow, including bypass.
 */

/** Claude Code tool names. Kept as a literal list so a typo here = compile-time error in the test. */
const TOOL_EDIT = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'] as const;
const TOOL_SHELL = ['Bash'] as const;
const TOOL_NETWORK = ['WebFetch', 'WebSearch'] as const;

/**
 * Translate {@link SessionPermissions} into the comma-separated `--disallowedTools` deny list.
 * Returns an empty array when every gate is open (full-auto) — caller skips the flag entirely.
 */
const disallowedToolsFor = (p: SessionPermissions): readonly string[] => {
  const denied: string[] = [];
  if (!p.canEditFiles) denied.push(...TOOL_EDIT);
  if (!p.canRunShell) denied.push(...TOOL_SHELL);
  if (!p.canAccessNetwork) denied.push(...TOOL_NETWORK);
  return denied;
};

/**
 * Build the argv for one Claude invocation from the {@link AiSession} descriptor.
 * Validates `session.model` is a known {@link ClaudeModel} so a typo or stale config
 * surfaces here rather than as an opaque CLI failure. Returns `Result.error(InvalidStateError)`
 * for unknowns; `Result.ok(args)` otherwise.
 */
export const buildClaudeArgs = (session: AiSession): Result<readonly string[], InvalidStateError> => {
  if (!isClaudeModel(session.model)) {
    return Result.error(
      new InvalidStateError({
        entity: 'claude-provider',
        currentState: 'model-validation',
        attemptedAction: 'build argv',
        message: `claude-provider: '${session.model}' is not a known Claude model`,
      })
    );
  }
  // `-p` is the print-mode flag — without it `claude` launches its interactive TUI and the
  // stdin-piped prompt is silently discarded. v1 hit the same gotcha; mirror the fix here.
  const args: string[] = ['-p', '--output-format', 'json', '--model', session.model];
  args.push('--permission-mode', 'bypassPermissions');
  const denied = disallowedToolsFor(session.permissions);
  if (denied.length > 0) {
    args.push('--disallowedTools', denied.join(','));
  }
  for (const root of session.additionalRoots ?? []) {
    args.push('--add-dir', String(root));
  }
  if (session.resume !== undefined) {
    args.push('--resume', String(session.resume));
  }
  return Result.ok(args);
};

export const createClaudeProvider = (deps: ClaudeProviderDeps): HeadlessAiProvider => {
  const spawnFn: ProviderSpawn = deps.spawn ?? defaultSpawn;
  const command = deps.command ?? 'claude';

  return {
    async generate(session) {
      const argsResult = buildClaudeArgs(session);
      if (!argsResult.ok) return Result.error(argsResult.error) as Result<ProviderOutput, DomainError>;
      const args = argsResult.value;
      // attempt 0 = first try; up to `rateLimitRetries` extra attempts after a rate-limit.
      const maxAttempts = deps.rateLimitRetries + 1;
      const schedule = deps.backoffSchedule ?? DEFAULT_BACKOFF_SCHEDULE;
      let lastRateLimit: RateLimitError | undefined;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const outcome = await spawnAttempt({ deps, spawnFn, command, args, session });
        if (outcome.kind === 'success') {
          return Result.ok(outcome.output) as Result<ProviderOutput, DomainError>;
        }
        if (outcome.kind === 'rate-limit') {
          lastRateLimit = outcome.error;
          deps.eventBus.publish({
            type: 'log',
            level: 'warn',
            message: `claude-provider: rate-limit on attempt ${String(attempt + 1)}/${String(maxAttempts)}`,
            meta: { attempt: attempt + 1, maxAttempts, subCode: outcome.error.subCode },
            at: IsoTimestamp.now(),
          });
          // Wait before retrying — gives a daily-quota throttle a chance to reset on a fresh
          // window. Only between attempts, not after the last one. Abort short-circuits the
          // sleep so user-initiated cancel doesn't have to wait through a 2-hour backoff.
          if (attempt < maxAttempts - 1) {
            const delayMs = delayForRetry(attempt + 1, schedule);
            if (delayMs > 0) {
              deps.eventBus.publish({
                type: 'log',
                level: 'info',
                message: `claude-provider: waiting ${String(delayMs)}ms before retry`,
                meta: { delayMs, nextAttempt: attempt + 2, maxAttempts },
                at: IsoTimestamp.now(),
              });
              await sleepCancellable(delayMs, session.abortSignal);
              if (session.abortSignal?.aborted === true) {
                return Result.error(
                  new InvalidStateError({
                    entity: 'claude-provider',
                    currentState: 'aborted-during-backoff',
                    attemptedAction: 'retry',
                    message: 'claude-provider: aborted by caller during rate-limit backoff',
                  })
                ) as Result<ProviderOutput, DomainError>;
              }
            }
          }
          continue;
        }
        return Result.error(outcome.error) as Result<ProviderOutput, DomainError>;
      }
      return Result.error(
        lastRateLimit ?? new RateLimitError({ subCode: 'spawn-stderr', message: 'rate-limit retries exhausted' })
      ) as Result<ProviderOutput, DomainError>;
    },
  };
};

type AttemptOutcome =
  | { readonly kind: 'success'; readonly output: ProviderOutput }
  | { readonly kind: 'rate-limit'; readonly error: RateLimitError }
  | { readonly kind: 'error'; readonly error: DomainError };

interface SpawnAttemptArgs {
  readonly deps: ClaudeProviderDeps;
  readonly spawnFn: ProviderSpawn;
  readonly command: string;
  readonly args: readonly string[];
  readonly session: AiSession;
}

/**
 * One spawn attempt: launch `claude`, write prompt, capture stdout in full, then JSON.parse
 * the captured stdout to recover the assistant body. Extracts harness signals from the body
 * and writes them to `session.signalsFile`; optionally mirrors the raw body to
 * `session.bodyFile`. The body is then dropped — it never crosses back to the caller.
 */
const spawnAttempt = async (input: SpawnAttemptArgs): Promise<AttemptOutcome> => {
  const { deps, spawnFn, command, args, session } = input;
  const child = spawnFn(command, args, {
    stdio: ['pipe', 'pipe', 'pipe'] as const,
  });
  let stdoutBuf = '';
  let stderrBuf = '';

  // Wait for the child to fully `'close'` — NOT just `'exit'`. `'exit'` can fire before the
  // final stdout chunk has been delivered to our listener; `'close'` guarantees the streams
  // have flushed. v1 uses the same event for the same reason.
  //
  // No wall-clock timeout: implement sessions can legitimately run for hours. The idle-stdout
  // watchdog (installed inside runHeadlessSpawn) handles the "stuck child" failure mode, and
  // `session.abortSignal` (Ctrl-C / TUI) threads through the same kill ladder.
  const { code, signal } = await runHeadlessSpawn({
    child,
    onStdout: (chunk) => {
      stdoutBuf += chunk;
    },
    onStderr: (chunk) => {
      stderrBuf += chunk;
    },
    stdin: session.prompt as unknown as string,
    resolveOn: 'close',
    ...(deps.idleMs !== undefined ? { idleMs: deps.idleMs } : {}),
    ...(session.abortSignal !== undefined ? { abortSignal: session.abortSignal } : {}),
    onIdle: () => {
      const idleMs = deps.idleMs ?? undefined;
      deps.eventBus.publish({
        type: 'log',
        level: 'warn',
        message: `claude-provider: no stdio activity${idleMs !== undefined ? ` for ${String(idleMs)}ms` : ''} — killing wedged child`,
        ...(idleMs !== undefined ? { meta: { idleMs } } : {}),
        at: IsoTimestamp.now(),
      });
    },
  });

  if (signal === 'SIGTERM') {
    return {
      kind: 'error',
      error: new InvalidStateError({
        entity: 'claude-provider',
        currentState: 'terminated',
        attemptedAction: 'complete generation',
        message: 'claude-provider: process terminated via SIGTERM',
      }),
    };
  }

  if (code === 0) {
    const envelope = parseClaudeJsonEnvelope(stdoutBuf);
    // Drop the spawn-side stdout buffer NOW. From here on the only string we hold is
    // `envelope.body`, and that goes out of scope when the function returns.
    stdoutBuf = '';
    if (envelope.sessionId !== undefined) {
      deps.eventBus.publish({
        type: 'log',
        level: 'debug',
        message: 'claude-provider: session id captured',
        meta: { sessionId: envelope.sessionId },
        at: IsoTimestamp.now(),
      });
    }
    const signals = parseHarnessSignals(envelope.body, IsoTimestamp.now());
    const wrote = await writeJsonAtomic(String(session.signalsFile), signals);
    if (!wrote.ok) return { kind: 'error', error: wrote.error };
    // Mirror raw body for diagnostic capture (detect-scripts / detect-skills empty-proposal
    // debugging). Best-effort: a write failure here is logged but does not fail the session.
    if (session.bodyFile !== undefined) {
      const bodyWrote = await writeTextAtomic(String(session.bodyFile), envelope.body);
      if (!bodyWrote.ok) {
        deps.eventBus.publish({
          type: 'log',
          level: 'warn',
          message: `claude-provider: failed to write body file — diagnostic capture skipped`,
          meta: { bodyFile: String(session.bodyFile), error: bodyWrote.error.message },
          at: IsoTimestamp.now(),
        });
      }
    }
    return {
      kind: 'success',
      output: {
        signalsFile: session.signalsFile,
        exitCode: code,
        ...(envelope.sessionId !== undefined ? { sessionId: envelope.sessionId } : {}),
      },
    };
  }

  // Non-zero exit. Rate-limit detection: stderr regex match — lean heuristic, easy to widen.
  if (RATE_LIMIT_RE.test(stderrBuf)) {
    // Best-effort: pull session id out of whatever stdout we captured, even on failure.
    const sessionIdOnFailure = parseClaudeJsonEnvelope(stdoutBuf).sessionId;
    return {
      kind: 'rate-limit',
      error: new RateLimitError({
        subCode: 'spawn-stderr',
        message: `claude-provider: rate-limit detected in stderr (exit ${String(code)})`,
        ...(sessionIdOnFailure !== undefined ? { sessionId: sessionIdOnFailure } : {}),
      }),
    };
  }

  return {
    kind: 'error',
    error: new InvalidStateError({
      entity: 'claude-provider',
      currentState: `exit-${String(code)}`,
      attemptedAction: 'complete generation',
      message: `claude-provider: process exited with code ${String(code)}: ${stderrBuf.trim() || '<empty stderr>'}`,
    }),
  };
};

const defaultSpawn: ProviderSpawn = (command, args, options) =>
  nodeSpawn(command, [...args], { stdio: [...options.stdio] }) as ChildProcessWithoutNullStreams;
