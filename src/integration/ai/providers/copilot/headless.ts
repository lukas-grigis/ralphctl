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
import { isCopilotModel } from '@src/domain/value/settings-models/copilot.ts';
import {
  createCopilotStreamParser,
  type CopilotStreamLine,
} from '@src/integration/ai/providers/copilot/parse-stream.ts';
import type { ProviderSpawn } from '@src/integration/ai/providers/_engine/spawn.ts';
import { runHeadlessSpawn } from '@src/integration/ai/providers/_engine/run-headless-spawn.ts';
import {
  DEFAULT_BACKOFF_SCHEDULE,
  delayForRetry,
  sleepCancellable,
} from '@src/integration/ai/providers/_engine/rate-limit-backoff.ts';
import { writeJsonAtomic } from '@src/integration/io/fs.ts';

/**
 * {@link HeadlessAiProvider} backed by the GitHub Copilot CLI (`copilot`, v1.0.12+).
 *
 * Translation table (intent → Copilot CLI flag):
 *
 *   | AiSession field                                       | Copilot flag                                       |
 *   | ----------------------------------------------------- | -------------------------------------------------- |
 *   | (always)                                              | `--output-format=json --silent --no-ask-user`      |
 *   | model: <CopilotModel>                                 | `--model=<model>`                                  |
 *   | additionalRoots: [a, b]                               | `--add-dir=a --add-dir=b`                          |
 *   | permissions {autoApprove,canEditFiles,canRunShell}    | `--allow-all`                                      |
 *   | permissions read-only (no edit, no shell)             | `--deny-tool=write --deny-tool=shell`              |
 *   | resume: <any>                                         | `InvalidStateError` — `-p` cannot resume           |
 *   | prompt                                                | argv: `-p <prompt>`                                |
 *
 * Resume note: Copilot's `--resume[=VALUE]` is documented as interactive-only ("Resume a
 * previous interactive session by choosing from a list"), and the official CLI reference
 * does not allow it alongside `-p` / `--prompt`. Per the {@link AiSession} fail-loud advisory
 * contract, this adapter surfaces `InvalidStateError` when a caller threads `resume` rather
 * than silently emitting a flag the CLI rejects. See
 * https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference.
 *
 * Copilot's prompt is passed as a CLI argument (`-p <text>`) rather than piped via stdin.
 * Argv length is the OS limit (~2MB on macOS); revisit if a chain hits it.
 *
 * Read-only permission is composed via `--deny-tool=write --deny-tool=shell` because Copilot
 * has no single equivalent of Claude's `--permission-mode plan`. Per the CLI docs, omitting
 * the parenthesised argument on a `--deny-tool=<Kind>` matches all tools of that kind. Deny
 * rules take precedence over allow rules.
 *
 * Output handling — file-based contract: stdout JSONL is consumed by
 * {@link createCopilotStreamParser}. Plain-text lines accumulate into a transient body buffer;
 * JSON records expose the `session_id` (logged + returned). On exit, the body is fed to
 * {@link parseHarnessSignals} and the parsed array written to `session.signalsFile`. The body
 * goes out of scope at function return — never retained on a domain entity.
 *
 * Test seam: `spawn` is a {@link ProviderSpawn} override so tests script stdout / stderr /
 * exit code without launching the real binary.
 *
 * Docs:
 *   - https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference
 *   - https://docs.github.com/en/copilot/how-tos/copilot-cli/allowing-tools (tool-kind syntax)
 */
export interface CopilotProviderDeps {
  readonly rateLimitRetries: number;
  readonly eventBus: EventBus;
  readonly spawn?: ProviderSpawn;
  /** Test seam: overrides the executable name. Defaults to `'copilot'`. */
  readonly command?: string;
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

const isFullAuto = (p: SessionPermissions): boolean => p.autoApprove && p.canEditFiles && p.canRunShell;

/**
 * Build the argv for one Copilot invocation. Validates `session.model` is a known
 * {@link CopilotModel}; surfaces `InvalidStateError` for unknowns.
 */
export const buildCopilotArgs = (session: AiSession): Result<readonly string[], InvalidStateError> => {
  if (!isCopilotModel(session.model)) {
    return Result.error(
      new InvalidStateError({
        entity: 'copilot-provider',
        currentState: 'model-validation',
        attemptedAction: 'build argv',
        message: `copilot-provider: '${session.model}' is not a known Copilot model`,
      })
    );
  }
  if (session.resume !== undefined) {
    return Result.error(
      new InvalidStateError({
        entity: 'copilot-provider',
        currentState: 'resume-with-print',
        attemptedAction: 'build argv',
        message:
          'copilot-provider: --resume is interactive-only and cannot combine with -p; AiSession.resume is not supported on the Copilot headless path',
      })
    );
  }
  // `--autopilot` is required for autonomous continuation; without it Copilot may pause
  // between actions in non-interactive mode and never finish the turn. v1's working headless
  // adapter sets this flag too — keeping the patterns aligned across versions.
  // `--model` and `--add-dir` are equals-only per the Copilot CLI reference; the space form
  // leaves the parser without a bound value and corrupts argv enough that the prompt seed
  // silently fails (interactive: empty input box; headless: no execution). Use `=value`.
  const args: string[] = [
    '--output-format=json',
    '--autopilot',
    '--silent',
    '--no-ask-user',
    `--model=${session.model}`,
  ];
  if (isFullAuto(session.permissions)) {
    args.push('--allow-all');
  } else {
    // Read-only / partial permissions → allow all tool kinds, then deny write + shell. The
    // CLI docs are explicit that deny rules take precedence over allow rules, so this combo
    // is "do anything except mutate files or run shell." Without an explicit allow the
    // non-denied tools (read, search) would still hit per-call confirmation prompts which
    // `--no-ask-user` then turns into refusals — the AI ends up unable to do anything.
    args.push('--allow-all-tools', '--deny-tool=write', '--deny-tool=shell');
  }
  for (const root of session.additionalRoots ?? []) {
    args.push(`--add-dir=${String(root)}`);
  }
  args.push('-p', session.prompt as unknown as string);
  return Result.ok(args);
};

export const createCopilotProvider = (deps: CopilotProviderDeps): HeadlessAiProvider => {
  const spawnFn: ProviderSpawn = deps.spawn ?? defaultSpawn;
  const command = deps.command ?? 'copilot';

  return {
    async generate(session) {
      const argsResult = buildCopilotArgs(session);
      if (!argsResult.ok) return Result.error(argsResult.error) as Result<ProviderOutput, DomainError>;
      const args = argsResult.value;
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
            message: `copilot-provider: rate-limit on attempt ${String(attempt + 1)}/${String(maxAttempts)}`,
            meta: { attempt: attempt + 1, maxAttempts, subCode: outcome.error.subCode },
            at: IsoTimestamp.now(),
          });
          if (attempt < maxAttempts - 1) {
            const delayMs = delayForRetry(attempt + 1, schedule);
            if (delayMs > 0) {
              deps.eventBus.publish({
                type: 'log',
                level: 'info',
                message: `copilot-provider: waiting ${String(delayMs)}ms before retry`,
                meta: { delayMs, nextAttempt: attempt + 2, maxAttempts },
                at: IsoTimestamp.now(),
              });
              await sleepCancellable(delayMs, session.abortSignal);
              if (session.abortSignal?.aborted === true) {
                return Result.error(
                  new InvalidStateError({
                    entity: 'copilot-provider',
                    currentState: 'aborted-during-backoff',
                    attemptedAction: 'retry',
                    message: 'copilot-provider: aborted by caller during rate-limit backoff',
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
  readonly deps: CopilotProviderDeps;
  readonly spawnFn: ProviderSpawn;
  readonly command: string;
  readonly args: readonly string[];
  readonly session: AiSession;
}

const spawnAttempt = async (input: SpawnAttemptArgs): Promise<AttemptOutcome> => {
  const { deps, spawnFn, command, args, session } = input;
  const child = spawnFn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] as const });
  const parser = createCopilotStreamParser();
  let body = '';
  let sessionId: string | undefined;
  let stderrBuf = '';

  const onLine = (line: CopilotStreamLine): void => {
    if (line.json !== undefined) {
      if (line.sessionId !== undefined && sessionId === undefined) {
        sessionId = line.sessionId;
        deps.eventBus.publish({
          type: 'log',
          level: 'debug',
          message: 'copilot-provider: session id captured',
          meta: { sessionId },
          at: IsoTimestamp.now(),
        });
      }
      deps.eventBus.publish({
        type: 'log',
        level: 'debug',
        message: 'copilot-provider: stdout meta line',
        meta: { raw: line.raw },
        at: IsoTimestamp.now(),
      });
      return;
    }
    body = body.length === 0 ? line.raw : `${body}\n${line.raw}`;
  };

  // Copilot reads the prompt from -p argv (no stdin payload). Tokens stream to stdout via the
  // ndjson `parser`; we wait for `'exit'` since the parser drains everything it sees inline.
  const { code, signal } = await runHeadlessSpawn({
    child,
    onStdout: (chunk) => parser.feed(chunk, onLine),
    onStderr: (chunk) => {
      stderrBuf += chunk;
    },
    resolveOn: 'exit',
    ...(deps.idleMs !== undefined ? { idleMs: deps.idleMs } : {}),
    ...(session.abortSignal !== undefined ? { abortSignal: session.abortSignal } : {}),
    onIdle: () => {
      const idleMs = deps.idleMs ?? undefined;
      deps.eventBus.publish({
        type: 'log',
        level: 'warn',
        message: `copilot-provider: no stdio activity${idleMs !== undefined ? ` for ${String(idleMs)}ms` : ''} — killing wedged child`,
        ...(idleMs !== undefined ? { meta: { idleMs } } : {}),
        at: IsoTimestamp.now(),
      });
    },
  });
  parser.flush(onLine);

  if (signal === 'SIGTERM') {
    return {
      kind: 'error',
      error: new InvalidStateError({
        entity: 'copilot-provider',
        currentState: 'terminated',
        attemptedAction: 'complete generation',
        message: 'copilot-provider: process terminated via SIGTERM',
      }),
    };
  }

  if (code === 0) {
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
        message: `copilot-provider: rate-limit detected in stderr (exit ${String(code)})`,
        ...(sessionId !== undefined ? { sessionId } : {}),
      }),
    };
  }

  return {
    kind: 'error',
    error: new InvalidStateError({
      entity: 'copilot-provider',
      currentState: `exit-${String(code)}`,
      attemptedAction: 'complete generation',
      message: `copilot-provider: process exited with code ${String(code)}: ${stderrBuf.trim() || '<empty stderr>'}`,
    }),
  };
};

const defaultSpawn: ProviderSpawn = (command, args, options) =>
  nodeSpawn(command, [...args], { stdio: [...options.stdio] }) as ChildProcessWithoutNullStreams;
