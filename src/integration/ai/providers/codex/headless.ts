import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { isCodexModel } from '@src/domain/value/settings-models/codex.ts';
import type { ProviderSpawn } from '@src/integration/ai/providers/_engine/spawn.ts';
import { runHeadlessSpawn } from '@src/integration/ai/providers/_engine/run-headless-spawn.ts';
import {
  DEFAULT_BACKOFF_SCHEDULE,
  delayForRetry,
  sleepCancellable,
} from '@src/integration/ai/providers/_engine/rate-limit-backoff.ts';
import { writeJsonAtomic } from '@src/integration/io/fs.ts';

/**
 * {@link HeadlessAiProvider} backed by the OpenAI Codex CLI (`codex` v0.130.0+).
 *
 * Translation table (intent → Codex CLI argv):
 *
 *   | AiSession field                   | Codex argv                                                 |
 *   | --------------------------------- | ---------------------------------------------------------- |
 *   | (always)                          | leading `exec` (or `exec resume <id>` when resume is set) |
 *   | (always)                          | `--ephemeral --skip-git-repo-check -o <tmpfile> --json`   |
 *   | model: <CodexModel>               | `-m <model>`                                               |
 *   | cwd                               | `-C <cwd>`                                                 |
 *   | additionalRoots: [a, b]           | `--add-dir a --add-dir b`                                  |
 *   | permissions = READ_ONLY           | `-s read-only -a never`                                    |
 *   | permissions = FULL_AUTO           | `-s workspace-write -a never`                              |
 *   | anything else                     | InvalidStateError (only the two locked profiles supported) |
 *   | reasoningEffort (dep-level)       | `-c model_reasoning_effort=<level>`                        |
 *   | (always, trailing)                | `-` (read prompt from stdin)                              |
 *   | prompt                            | piped to stdin                                             |
 *
 * The trailing `-` is codex's documented sentinel for "the prompt is on stdin." Without it,
 * codex would treat the piped data as side context and wait for a positional prompt arg —
 * causing the call to hang. See https://github.com/openai/codex/blob/main/docs/exec.md.
 *
 * Output handling — file-based contract: codex's `-o <tmpfile>` writes the final assistant
 * message to a tempfile; after exit the adapter reads it, runs {@link parseHarnessSignals},
 * and writes the result array to `session.signalsFile`. The body string is dropped — it
 * never leaves this function. Every tag downstream flows care about (`<task-verified>`,
 * `<setup-script>`, `<claude-md>`, …) has a registered parser, so signals.json is the single
 * uniform read-path.
 *
 * Session id capture: codex emits JSONL meta events on stdout that carry `session_id` on the
 * leading config / startup record. The adapter line-buffers stdout, picks the first id out,
 * and discards the rest of the stream (the body is read from the tempfile).
 *
 * Permissions: only the two locked profiles (READ_ONLY / FULL_AUTO) are supported, since
 * those cover every wired chain. Half-permission combos surface `InvalidStateError` —
 * fail loud beats silent surprise.
 *
 * Test seam: `spawn` is overridable so tests script stdout / stderr / exit code without
 * launching the real `codex` binary. `readFile` / `unlink` are also injectable for unit
 * tests that exercise the body-capture path without disk I/O.
 *
 * Docs:
 *   - https://developers.openai.com/codex/cli/reference (top-level + `exec` flags)
 *   - https://developers.openai.com/codex/noninteractive (`-o`, `--json`, stdin sentinel)
 */
export interface CodexProviderDeps {
  readonly rateLimitRetries: number;
  readonly eventBus: EventBus;
  readonly spawn?: ProviderSpawn;
  /** Test seam: overrides the executable name. Defaults to `'codex'`. */
  readonly command?: string;
  /**
   * Optional reasoning effort. Codex sets this via `-c model_reasoning_effort=<level>`.
   * Operational concern (per-adapter, not per-call) so it lives on Deps rather than
   * `AiSession`. Defaults to omitted (uses codex's own default — currently `'medium'`).
   */
  readonly reasoningEffort?: 'low' | 'medium' | 'high';
  /** Test seam: read the captured tempfile. Defaults to `fs.readFile`. */
  readonly readFile?: (path: string) => Promise<string>;
  /** Test seam: delete the captured tempfile. Defaults to `fs.unlink` (best-effort). */
  readonly unlink?: (path: string) => Promise<void>;
  /** Test seam: pick the tempfile path. Defaults to `os.tmpdir()/ralphctl-codex-<n>.txt`. */
  readonly mkTempPath?: () => string;
  /**
   * Milliseconds of stdio silence before the adapter SIGTERMs a wedged child. Defaults to
   * {@link DEFAULT_IDLE_MS} (5 min). Lower in tests to exercise the watchdog path.
   */
  readonly idleMs?: number;
  /**
   * Wait schedule between rate-limit retries. Defaults to {@link DEFAULT_BACKOFF_SCHEDULE}.
   * Tests pass `[0, 0, …]` to skip the waits.
   */
  readonly backoffSchedule?: readonly number[];
}

const RATE_LIMIT_RE = /rate.?limit/i;

/**
 * Map our READ_ONLY / FULL_AUTO permission profiles onto codex's `-s/--sandbox` policy.
 *
 * Codex `exec` (non-interactive) does NOT expose an approval flag — there's no human to
 * escalate to, so the sandbox alone defines the safety envelope. The interactive `codex`
 * command keeps `-a/--ask-for-approval`; that path is handled in `interactive.ts`.
 */
const sandboxFor = (
  p: SessionPermissions
): Result<{ readonly sandbox: 'read-only' | 'workspace-write' }, InvalidStateError> => {
  const isReadOnly = !p.canEditFiles && !p.canRunShell;
  const isFullAuto = p.canEditFiles && p.canRunShell && p.autoApprove;
  if (isReadOnly) return Result.ok({ sandbox: 'read-only' });
  if (isFullAuto) return Result.ok({ sandbox: 'workspace-write' });
  return Result.error(
    new InvalidStateError({
      entity: 'codex-provider',
      currentState: 'permission-mapping',
      attemptedAction: 'build argv',
      message:
        'codex-provider: only READ_ONLY and FULL_AUTO permission profiles are supported; got an intermediate combination',
    })
  );
};

interface BuildCodexArgsOpts {
  readonly outputFile: string;
  readonly reasoningEffort?: 'low' | 'medium' | 'high';
}

/**
 * Build the argv for one Codex invocation. Validates `session.model` against
 * {@link CodexModel} and `session.permissions` against the two locked profiles;
 * surfaces `InvalidStateError` for either failure.
 */
export const buildCodexArgs = (
  session: AiSession,
  opts: BuildCodexArgsOpts
): Result<readonly string[], InvalidStateError> => {
  if (!isCodexModel(session.model)) {
    return Result.error(
      new InvalidStateError({
        entity: 'codex-provider',
        currentState: 'model-validation',
        attemptedAction: 'build argv',
        message: `codex-provider: '${session.model}' is not a known Codex model`,
      })
    );
  }
  const perms = sandboxFor(session.permissions);
  if (!perms.ok) return Result.error(perms.error);

  const args: string[] = ['exec'];
  if (session.resume !== undefined) {
    args.push('resume', String(session.resume));
  }
  args.push(
    '--ephemeral',
    '--skip-git-repo-check',
    '-o',
    opts.outputFile,
    '--json',
    '-m',
    session.model,
    '-C',
    String(session.cwd),
    '-s',
    perms.value.sandbox
  );
  for (const root of session.additionalRoots ?? []) {
    args.push('--add-dir', String(root));
  }
  if (opts.reasoningEffort !== undefined) {
    args.push('-c', `model_reasoning_effort=${opts.reasoningEffort}`);
  }
  // Trailing `-` tells codex to read the prompt from stdin. Required when no positional
  // prompt arg is given — without it, codex hangs waiting for the arg.
  args.push('-');
  return Result.ok(args);
};

let tempCounter = 0;
const defaultMkTempPath = (): string => {
  tempCounter += 1;
  return join(tmpdir(), `ralphctl-codex-${String(process.pid)}-${String(Date.now())}-${String(tempCounter)}.txt`);
};

export const createCodexProvider = (deps: CodexProviderDeps): HeadlessAiProvider => {
  const spawnFn: ProviderSpawn = deps.spawn ?? defaultSpawn;
  const command = deps.command ?? 'codex';
  const readFile = deps.readFile ?? ((path) => fs.readFile(path, 'utf8'));
  const unlink =
    deps.unlink ??
    (async (path: string): Promise<void> => {
      await fs.unlink(path).catch(() => {
        // best-effort cleanup; orphan tempfiles are bounded by os.tmpdir() rotation
      });
    });
  const mkTempPath = deps.mkTempPath ?? defaultMkTempPath;

  return {
    async generate(session) {
      const outputFile = mkTempPath();
      const argsResult = buildCodexArgs(session, {
        outputFile,
        ...(deps.reasoningEffort !== undefined ? { reasoningEffort: deps.reasoningEffort } : {}),
      });
      if (!argsResult.ok) return Result.error(argsResult.error) as Result<ProviderOutput, DomainError>;
      const args = argsResult.value;

      try {
        const maxAttempts = deps.rateLimitRetries + 1;
        const schedule = deps.backoffSchedule ?? DEFAULT_BACKOFF_SCHEDULE;
        let lastRateLimit: RateLimitError | undefined;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          const outcome = await spawnAttempt({ deps, spawnFn, command, args, session, readFile, outputFile });
          if (outcome.kind === 'success') {
            return Result.ok(outcome.output) as Result<ProviderOutput, DomainError>;
          }
          if (outcome.kind === 'rate-limit') {
            lastRateLimit = outcome.error;
            deps.eventBus.publish({
              type: 'log',
              level: 'warn',
              message: `codex-provider: rate-limit on attempt ${String(attempt + 1)}/${String(maxAttempts)}`,
              meta: { attempt: attempt + 1, maxAttempts, subCode: outcome.error.subCode },
              at: IsoTimestamp.now(),
            });
            if (attempt < maxAttempts - 1) {
              const delayMs = delayForRetry(attempt + 1, schedule);
              if (delayMs > 0) {
                deps.eventBus.publish({
                  type: 'log',
                  level: 'info',
                  message: `codex-provider: waiting ${String(delayMs)}ms before retry`,
                  meta: { delayMs, nextAttempt: attempt + 2, maxAttempts },
                  at: IsoTimestamp.now(),
                });
                await sleepCancellable(delayMs, session.abortSignal);
                if (session.abortSignal?.aborted === true) {
                  return Result.error(
                    new InvalidStateError({
                      entity: 'codex-provider',
                      currentState: 'aborted-during-backoff',
                      attemptedAction: 'retry',
                      message: 'codex-provider: aborted by caller during rate-limit backoff',
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
      } finally {
        await unlink(outputFile);
      }
    },
  };
};

type AttemptOutcome =
  | { readonly kind: 'success'; readonly output: ProviderOutput }
  | { readonly kind: 'rate-limit'; readonly error: RateLimitError }
  | { readonly kind: 'error'; readonly error: DomainError };

interface SpawnAttemptArgs {
  readonly deps: CodexProviderDeps;
  readonly spawnFn: ProviderSpawn;
  readonly command: string;
  readonly args: readonly string[];
  readonly session: AiSession;
  readonly readFile: (path: string) => Promise<string>;
  readonly outputFile: string;
}

/**
 * Line-extract `session_id` (or `sessionId`) from codex's JSONL stdout. Returns the residual
 * tail (unterminated trailing chars). Invokes `onId` at most once per call per id seen; the
 * caller dedupes to "first wins."
 */
const consumeSessionIdLines = (buffer: string, onId: (id: string) => void): string => {
  let remaining = buffer;
  while (true) {
    const nl = remaining.indexOf('\n');
    if (nl === -1) return remaining;
    const line = remaining.slice(0, nl);
    remaining = remaining.slice(nl + 1);
    const trimmed = line.trim();
    if (trimmed.length === 0 || !trimmed.startsWith('{')) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const id = stringField(obj, 'session_id', 'sessionId');
      if (id !== undefined) onId(id);
    } catch {
      // non-JSON line — codex occasionally prints banner text alongside json records; skip
    }
  }
};

const stringField = (obj: Record<string, unknown>, ...names: readonly string[]): string | undefined => {
  for (const name of names) {
    const v = obj[name];
    if (typeof v === 'string') return v;
  }
  return undefined;
};

const spawnAttempt = async (input: SpawnAttemptArgs): Promise<AttemptOutcome> => {
  const { deps, spawnFn, command, args, session, readFile, outputFile } = input;
  const child = spawnFn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] as const });
  let stderrBuf = '';
  let sessionId: string | undefined;
  let stdoutLineBuf = '';

  // Codex `exec` reads the prompt from stdin; codex streams tokens to stdout so we attach a
  // line-buffering session-id sniffer and wait for `'exit'` (no need to wait for streams to
  // flush after exit — the session id is captured inline).
  const { code, signal } = await runHeadlessSpawn({
    child,
    onStdout: (chunk) => {
      stdoutLineBuf = consumeSessionIdLines(stdoutLineBuf + chunk, (id) => {
        if (sessionId === undefined) {
          sessionId = id;
          deps.eventBus.publish({
            type: 'log',
            level: 'debug',
            message: 'codex-provider: session id captured',
            meta: { sessionId: id },
            at: IsoTimestamp.now(),
          });
        }
      });
    },
    onStderr: (chunk) => {
      stderrBuf += chunk;
    },
    stdin: session.prompt as unknown as string,
    resolveOn: 'exit',
    ...(deps.idleMs !== undefined ? { idleMs: deps.idleMs } : {}),
    ...(session.abortSignal !== undefined ? { abortSignal: session.abortSignal } : {}),
    onIdle: () => {
      const idleMs = deps.idleMs ?? undefined;
      deps.eventBus.publish({
        type: 'log',
        level: 'warn',
        message: `codex-provider: no stdio activity${idleMs !== undefined ? ` for ${String(idleMs)}ms` : ''} — killing wedged child`,
        ...(idleMs !== undefined ? { meta: { idleMs } } : {}),
        at: IsoTimestamp.now(),
      });
    },
  });

  if (signal === 'SIGTERM') {
    return {
      kind: 'error',
      error: new InvalidStateError({
        entity: 'codex-provider',
        currentState: 'terminated',
        attemptedAction: 'complete generation',
        message: 'codex-provider: process terminated via SIGTERM',
      }),
    };
  }

  if (code === 0) {
    let body: string;
    try {
      body = await readFile(outputFile);
    } catch (err) {
      return {
        kind: 'error',
        error: new InvalidStateError({
          entity: 'codex-provider',
          currentState: 'output-capture',
          attemptedAction: 'read tempfile',
          message: `codex-provider: failed to read output tempfile: ${err instanceof Error ? err.message : String(err)}`,
        }),
      };
    }
    const signals = parseHarnessSignals(body, IsoTimestamp.now());
    const wrote = await writeJsonAtomic(String(session.signalsFile), signals);
    if (!wrote.ok) return { kind: 'error', error: wrote.error };
    return {
      kind: 'success',
      output: {
        signalsFile: session.signalsFile,
        exitCode: code,
        ...(sessionId !== undefined ? { sessionId } : {}),
      },
    };
  }

  if (RATE_LIMIT_RE.test(stderrBuf)) {
    return {
      kind: 'rate-limit',
      error: new RateLimitError({
        subCode: 'spawn-stderr',
        message: `codex-provider: rate-limit detected in stderr (exit ${String(code)})`,
        ...(sessionId !== undefined ? { sessionId } : {}),
      }),
    };
  }

  return {
    kind: 'error',
    error: new InvalidStateError({
      entity: 'codex-provider',
      currentState: `exit-${String(code)}`,
      attemptedAction: 'complete generation',
      message: `codex-provider: process exited with code ${String(code)}: ${stderrBuf.trim() || '<empty stderr>'}`,
    }),
  };
};

const defaultSpawn: ProviderSpawn = (command, args, options) =>
  nodeSpawn(command, [...args], { stdio: [...options.stdio] }) as ChildProcessWithoutNullStreams;
