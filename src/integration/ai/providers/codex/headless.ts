import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type { HeadlessAiProvider, ProviderOutput } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import { resolveWritableRoots } from '@src/integration/ai/providers/_engine/resolve-roots.ts';
import type { SessionPermissions } from '@src/integration/ai/providers/_engine/session-permissions.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { RateLimitError } from '@src/domain/value/error/rate-limit-error.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { isCodexModel } from '@src/domain/value/settings-models/codex.ts';
import type { ProviderSpawn } from '@src/integration/ai/providers/_engine/spawn.ts';
import { runHeadlessSpawn } from '@src/integration/ai/providers/_engine/run-headless-spawn.ts';
import {
  DEFAULT_BACKOFF_SCHEDULE,
  delayForRetry,
  sleepCancellable,
} from '@src/integration/ai/providers/_engine/rate-limit-backoff.ts';
import { writeTextAtomic } from '@src/integration/io/fs.ts';
import { persistSessionIdFile } from '@src/integration/ai/providers/_engine/persist-session-id.ts';
import { contextWindowFor } from '@src/integration/ai/providers/_engine/context-window.ts';

/**
 * {@link HeadlessAiProvider} backed by the OpenAI Codex CLI (`codex` v0.130.0+).
 *
 * Translation table (intent → Codex CLI argv):
 *
 *   | AiSession field                   | Codex argv                                                      |
 *   | --------------------------------- | --------------------------------------------------------------- |
 *   | fresh session                     | `exec`                                                          |
 *   | resume: <SessionId>               | `exec resume <id>`                                              |
 *   | (always)                          | `--ephemeral --skip-git-repo-check -o <tmpfile> --json`        |
 *   | model: <CodexModel>               | `-m <model>`                                                    |
 *   | cwd                               | `-C <cwd>` (fresh only; `exec resume` does not accept it)      |
 *   | additionalRoots: [a, b]           | `--add-dir a --add-dir b` (fresh only; `exec resume` does not) |
 *   | permissions = READ_ONLY           | `-s read-only` (fresh only)                                     |
 *   | permissions = FULL_AUTO           | `-s workspace-write` (fresh only)                               |
 *   | anything else                     | InvalidStateError (only the two locked profiles supported)      |
 *   | reasoningEffort (dep-level)       | `-c model_reasoning_effort=<level>`                             |
 *   | (always, trailing)                | `-` (read prompt from stdin)                                    |
 *   | prompt                            | piped to stdin                                                  |
 *
 * The trailing `-` is codex's documented sentinel for "the prompt is on stdin." Without it,
 * codex would treat the piped data as side context and wait for a positional prompt arg —
 * causing the call to hang. See https://github.com/openai/codex/blob/main/docs/exec.md.
 *
 * Output handling — audit-[09] contract: codex's `-o <tmpfile>` writes the final assistant
 * message to a tempfile; after exit the adapter reads it for forensic body capture. The AI
 * writes `signals.json` directly via its Write tool into `session.outputDir`; the harness
 * validates it post-spawn — the provider never touches signals.json. When `session.bodyFile`
 * is set, the adapter mirrors the raw body there for diagnostic capture (best-effort).
 *
 * Session id capture: codex emits JSONL meta events on stdout that carry `session_id` on the
 * leading config / startup record. The adapter line-buffers stdout, picks the first id out,
 * and discards the rest of the stream (the body is read from the tempfile).
 *
 * Permissions: only the two locked profiles (READ_ONLY / FULL_AUTO) are supported, since
 * those cover every wired chain. Half-permission combos surface `InvalidStateError` —
 * fail loud beats silent surprise. Codex `exec` on v0.130.0 does not expose a `--search`
 * flag, so the headless adapter cannot currently translate `canAccessNetwork`; sessions run
 * without the native live-web-search tool even though the shared permission model keeps the
 * bit for cross-provider parity.
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
 * Map our SessionPermissions onto codex's `-s/--sandbox` policy.
 *
 * Codex `exec` has only two non-interactive sandbox modes:
 *
 *   - `read-only`        — blocks every write, including signals.json. Incompatible with
 *                          the audit-[09] contract (the AI MUST write the envelope).
 *   - `workspace-write`  — allows writes inside `cwd + --add-dir` paths.
 *
 * Every profile therefore maps to `workspace-write`. Path scope (cwd + `additionalRoots`
 * + `outputDir`) is the safety envelope, not the sandbox flag. This is more permissive
 * than Claude/Copilot — Codex cannot deny `Edit` on existing repo files while still
 * allowing `Write` on signals.json. Document this in CLAUDE.md and let the topology
 * decide what's reachable.
 *
 * The interactive `codex` command keeps `-a/--ask-for-approval`; that path is handled in
 * `interactive.ts`.
 */
const sandboxFor = (_p: SessionPermissions): Result<{ readonly sandbox: 'workspace-write' }, InvalidStateError> => {
  void _p;
  return Result.ok({ sandbox: 'workspace-write' });
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
  const isResume = session.resume !== undefined;
  if (isResume) {
    args.push('resume', String(session.resume));
  }
  args.push('--ephemeral', '--skip-git-repo-check', '-o', opts.outputFile, '--json', '-m', session.model);
  if (!isResume) {
    args.push('-C', String(session.cwd), '-s', perms.value.sandbox);
    // Auto-mount `outputDir` so signals.json can land inside the workspace-write sandbox.
    // See resolve-roots.ts for the dedup rules.
    for (const root of resolveWritableRoots(session)) {
      args.push('--add-dir', String(root));
    }
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
            const bannerId = `rate-limit-codex-${outcome.error.sessionId ?? String(attempt + 1)}`;
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
                deps.eventBus.publish({
                  type: 'banner-show',
                  id: bannerId,
                  tier: 'info',
                  message: `Rate limit (codex) — waiting ${Math.round(delayMs / 1000).toString()}s before retry`,
                  cause: `attempt ${String(attempt + 1)}/${String(maxAttempts)}`,
                  at: IsoTimestamp.now(),
                });
                await sleepCancellable(delayMs, session.abortSignal);
                deps.eventBus.publish({ type: 'banner-clear', id: bannerId, at: IsoTimestamp.now() });
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

interface CodexMetaUpdate {
  readonly sessionId?: string;
  readonly model?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

/**
 * Line-extract `session_id` / `model` / token-usage fields from codex's JSONL stdout. Returns
 * the residual tail (unterminated trailing chars). `onMeta` is invoked once per recognised
 * line carrying any of the fields; the caller dedupes (sessionId / model = first wins; usage
 * = last wins).
 *
 * Codex's `--json` stream is JSONL: the leading `{type:"config"}` record carries `session_id`,
 * subsequent `{type:"task_complete"|"thread_meta"|...}` records may carry `model` and/or a
 * token-count object. Schema-tolerant: any unrecognised structure is skipped silently.
 */
const consumeMetaLines = (buffer: string, onMeta: (update: CodexMetaUpdate) => void): string => {
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
      const model = stringField(obj, 'model');
      const usageObj = obj['usage'];
      const source = isRecord(usageObj) ? usageObj : obj;
      const i = numberField(source, 'input_tokens', 'inputTokens', 'prompt_tokens');
      const o = numberField(source, 'output_tokens', 'outputTokens', 'completion_tokens');
      if (id === undefined && model === undefined && i === undefined && o === undefined) continue;
      onMeta({
        ...(id !== undefined ? { sessionId: id } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(i !== undefined ? { inputTokens: i } : {}),
        ...(o !== undefined ? { outputTokens: o } : {}),
      });
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

const numberField = (obj: Record<string, unknown>, ...names: readonly string[]): number | undefined => {
  for (const name of names) {
    const v = obj[name];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

const spawnAttempt = async (input: SpawnAttemptArgs): Promise<AttemptOutcome> => {
  const { deps, spawnFn, command, args, session, readFile, outputFile } = input;
  // `cwd` is set in addition to codex's argv `-C` so context-file autoload works on `exec resume`
  // (which does not accept `-C`) and is consistent with the other two adapters.
  // See CLAUDE.md §Security — "Cwd is the repo because Claude / Copilot / Codex only
  // auto-discover their context file from cwd."
  const child = spawnFn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] as const, cwd: String(session.cwd) });
  let stderrBuf = '';
  let sessionId: string | undefined;
  let stdoutLineBuf = '';

  // Codex `exec` reads the prompt from stdin; codex streams tokens to stdout so we attach a
  // line-buffering session-id sniffer and wait for `'exit'` (no need to wait for streams to
  // flush after exit — the session id is captured inline).
  let model: string | undefined;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  const { code, signal } = await runHeadlessSpawn({
    child,
    onStdout: (chunk) => {
      stdoutLineBuf = consumeMetaLines(stdoutLineBuf + chunk, (update) => {
        if (update.sessionId !== undefined && sessionId === undefined) {
          sessionId = update.sessionId;
          deps.eventBus.publish({
            type: 'log',
            level: 'debug',
            message: 'codex-provider: session id captured',
            meta: { sessionId: update.sessionId },
            at: IsoTimestamp.now(),
          });
        }
        if (update.model !== undefined && model === undefined) {
          model = update.model;
        }
        // Last-write-wins on usage — codex's `task_complete` record carries the cumulative
        // figure; earlier records (config / streaming chunks) report partials or nothing.
        if (update.inputTokens !== undefined) inputTokens = update.inputTokens;
        if (update.outputTokens !== undefined) outputTokens = update.outputTokens;
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
      deps.eventBus.publish({
        type: 'banner-show',
        id: `watchdog-codex-${String(child.pid ?? 'unknown')}`,
        tier: 'warn',
        message: `Watchdog killed stuck codex process${idleMs !== undefined ? ` (${String(Math.round(idleMs / 1000))}s idle)` : ''}`,
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
      // Single-shot read of the codex output tempfile — no per-line in-process accumulation.
      // Preserve that: any future streaming variant must use an O(N) accumulator (see the
      // `bodyLines.push` + `.join('\n')` pattern in copilot/headless.ts).
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
    // audit-[09]: the AI writes `signals.json` directly via its Write tool into
    // `session.outputDir`; the harness validates it post-spawn. The provider never writes
    // signals.json itself. The codex output tempfile body remains the forensic source for
    // `session.bodyFile` mirroring below.
    // Persist captured session id as a sibling `sessionId` file. Codex emits the id on the
    // leading JSONL config record; missing → skip (no empty marker). See persistSessionIdFile.
    const sidWrote = await persistSessionIdFile(session.signalsFile, sessionId);
    if (sidWrote !== undefined && !sidWrote.ok) {
      deps.eventBus.publish({
        type: 'log',
        level: 'warn',
        message: `codex-provider: failed to write sessionId file — resume re-attach may need log parsing`,
        meta: { error: sidWrote.error.message },
        at: IsoTimestamp.now(),
      });
    }
    if (session.bodyFile !== undefined) {
      const bodyWrote = await writeTextAtomic(String(session.bodyFile), body);
      if (!bodyWrote.ok) {
        deps.eventBus.publish({
          type: 'log',
          level: 'warn',
          message: `codex-provider: failed to write body file — diagnostic capture skipped`,
          meta: { bodyFile: String(session.bodyFile), error: bodyWrote.error.message },
          at: IsoTimestamp.now(),
        });
      }
    }
    if (sessionId !== undefined) {
      // Emit one TokenUsageEvent per clean-termination spawn. Codex commonly omits token counts
      // from the JSONL records on v0.130.x; the event still fires so subscribers can correlate
      // sessionId → provider without inferring success from token-field absence.
      const window = contextWindowFor(model);
      deps.eventBus.publish({
        type: 'token-usage',
        sessionId,
        provider: 'openai-codex',
        ...(model !== undefined ? { model } : {}),
        ...(inputTokens !== undefined ? { inputTokens } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {}),
        ...(window !== undefined ? { contextWindow: window } : {}),
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
  nodeSpawn(command, [...args], {
    stdio: [...options.stdio],
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
  }) as ChildProcessWithoutNullStreams;
