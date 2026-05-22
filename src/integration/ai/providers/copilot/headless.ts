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
import { writeJsonAtomic, writeTextAtomic } from '@src/integration/io/fs.ts';
import { persistSessionIdFile } from '@src/integration/ai/providers/_engine/persist-session-id.ts';
import { contextWindowFor } from '@src/integration/ai/providers/_engine/context-window.ts';
import type { CopilotUsage } from '@src/integration/ai/providers/copilot/parse-stream.ts';

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
 *   | resume: <id>                                          | `--resume=<id>`                                    |
 *   | prompt                                                | argv: `-p <prompt>`                                |
 *
 * Resume note: current Copilot CLI accepts `--resume[=VALUE]` with `-p` / `--prompt`.
 * The adapter forwards {@link AiSession.resume} when present so headless runs can re-attach
 * to a prior session id.
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
 * {@link parseHarnessSignals} and the parsed array written to `session.signalsFile`. When
 * `session.bodyFile` is set (one-shot flows like detect-scripts that may surface an empty
 * signal set), the raw accumulated body is mirrored there for forensic capture — best-effort,
 * a write failure here is logged but does not fail the spawn. The body itself goes out of
 * scope at function return — never retained on a domain entity.
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
  // `--autopilot` is required for autonomous continuation; without it Copilot may pause
  // between actions in non-interactive mode and never finish the turn. v1's working headless
  // adapter sets this flag too — keeping the patterns aligned across versions.
  // We use `--model=<value>` / `--add-dir=<value>` for deterministic argv construction.
  const args: string[] = [
    '--output-format=json',
    '--autopilot',
    '--silent',
    '--no-ask-user',
    `--model=${session.model}`,
  ];
  if (session.resume !== undefined) {
    args.push(`--resume=${String(session.resume)}`);
  }
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
          const bannerId = `rate-limit-copilot-${outcome.error.sessionId ?? String(attempt + 1)}`;
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
              deps.eventBus.publish({
                type: 'banner-show',
                id: bannerId,
                tier: 'info',
                message: `Rate limit (copilot) — waiting ${Math.round(delayMs / 1000).toString()}s before retry`,
                cause: `attempt ${String(attempt + 1)}/${String(maxAttempts)}`,
                at: IsoTimestamp.now(),
              });
              await sleepCancellable(delayMs, session.abortSignal);
              deps.eventBus.publish({ type: 'banner-clear', id: bannerId, at: IsoTimestamp.now() });
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
  // `cwd` is critical — the Copilot CLI only auto-discovers `.github/copilot-instructions.md`,
  // skills, agents, and `.mcp.json` from the child's `process.cwd()`. Without this, the
  // native context-file pipeline silently misses and the AI runs without project guidance.
  // See CLAUDE.md §Security — "Cwd is the repo because Claude / Copilot / Codex only
  // auto-discover their context file from cwd."
  const child = spawnFn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] as const, cwd: String(session.cwd) });
  const parser = createCopilotStreamParser();
  // Two buffers, one tagged event log: assistant body text feeds signal parsing; the
  // forensic body.txt mirrors every assistant + unrecognised-event line in stream order.
  // Splitting matters because Copilot echoes the prompt as a `user.message` event whose raw
  // JSONL would otherwise be matched by the harness signal regexes (literal `<task-blocked>`
  // inside the prompt → fake signal). Order preservation: derive both views from one tagged
  // event list rather than two parallel arrays.
  const events: Array<{ readonly assistant: boolean; readonly text: string }> = [];
  let sessionId: string | undefined;
  let model: string | undefined;
  let usage: CopilotUsage = {};
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
      if (line.model !== undefined && model === undefined) {
        model = line.model;
      }
      // Last-write-wins on usage. Copilot occasionally emits multiple meta lines through a
      // spawn; whichever lands last is the most current cumulative count.
      if (line.usage !== undefined) {
        usage = line.usage;
      }
      if (line.bodyText !== undefined && line.bodyText.length > 0) {
        events.push({ assistant: true, text: line.bodyText });
      } else if (line.sessionId === undefined && line.model === undefined && line.usage === undefined) {
        // Unrecognised JSON event — keep the raw form so `body.txt` (when bodyFile is set)
        // captures Copilot's actual stream shapes. NEVER feed this to the signal parser:
        // Copilot echoes the prompt as `user.message`, which carries literal harness tags.
        events.push({ assistant: false, text: line.raw });
      }
      deps.eventBus.publish({
        type: 'log',
        level: 'debug',
        message: 'copilot-provider: stdout json line',
        meta: { raw: line.raw },
        at: IsoTimestamp.now(),
      });
      return;
    }
    // Non-JSON lines (banner/status); preserve in body.txt but keep out of signal parsing.
    events.push({ assistant: false, text: line.raw });
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
      deps.eventBus.publish({
        type: 'banner-show',
        id: `watchdog-copilot-${String(child.pid ?? 'unknown')}`,
        tier: 'warn',
        message: `Watchdog killed stuck copilot process${idleMs !== undefined ? ` (${String(Math.round(idleMs / 1000))}s idle)` : ''}`,
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
    // Assistant body: feeds signal parsing. Forensic body: superset for body.txt, preserves
    // stream order so a human reading the file sees exactly what the CLI produced.
    const assistantBody = events
      .filter((e) => e.assistant)
      .map((e) => e.text)
      .join('\n');
    const forensicBody = events.map((e) => e.text).join('\n');
    const signals = parseHarnessSignals(assistantBody, IsoTimestamp.now());
    const wrote = await writeJsonAtomic(String(session.signalsFile), signals);
    if (!wrote.ok) return { kind: 'error', error: wrote.error };
    // Mirror raw body for diagnostic capture (detect-scripts / detect-skills empty-proposal
    // debugging). Best-effort: a write failure here is logged but does not fail the session.
    // Critically, the body is captured even when `parseHarnessSignals` returns an empty array,
    // so operators can see what the model actually produced when no recognised tag landed.
    if (session.bodyFile !== undefined) {
      const bodyWrote = await writeTextAtomic(String(session.bodyFile), forensicBody);
      if (!bodyWrote.ok) {
        deps.eventBus.publish({
          type: 'log',
          level: 'warn',
          message: `copilot-provider: failed to write body file — diagnostic capture skipped`,
          meta: { bodyFile: String(session.bodyFile), error: bodyWrote.error.message },
          at: IsoTimestamp.now(),
        });
      }
    }
    if (sessionId !== undefined) {
      // Emit one TokenUsageEvent per clean-termination spawn — even when Copilot omits usage
      // counters from the meta line, sessionId + provider + (maybe) model is still useful for
      // a TUI widget that correlates rounds with provider sessions. Honest about absent fields.
      const window = contextWindowFor(model);
      deps.eventBus.publish({
        type: 'token-usage',
        sessionId,
        provider: 'github-copilot',
        ...(model !== undefined ? { model } : {}),
        ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
        ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
        ...(window !== undefined ? { contextWindow: window } : {}),
        at: IsoTimestamp.now(),
      });
    }
    // Persist captured session id as a sibling `sessionId` file. Copilot streams the id on a
    // leading JSON meta line; if it was missing (banner-only streams, crash before meta) we
    // skip rather than write an empty marker. See persistSessionIdFile for the contract.
    const sidWrote = await persistSessionIdFile(session.signalsFile, sessionId);
    if (sidWrote !== undefined && !sidWrote.ok) {
      deps.eventBus.publish({
        type: 'log',
        level: 'warn',
        message: `copilot-provider: failed to write sessionId file — resume re-attach may need log parsing`,
        meta: { error: sidWrote.error.message },
        at: IsoTimestamp.now(),
      });
    }
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
  nodeSpawn(command, [...args], {
    stdio: [...options.stdio],
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
  }) as ChildProcessWithoutNullStreams;
