import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { crossPlatformSpawn } from '@src/integration/io/cross-platform-spawn.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type { HeadlessAiProvider, ProviderOutput } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import type { CodexProviderDeps } from '@src/integration/ai/providers/_engine/codex-provider-deps.ts';
import { resolveWritableRoots } from '@src/integration/ai/providers/_engine/resolve-roots.ts';
import type { SessionPermissions } from '@src/integration/ai/providers/_engine/session-permissions.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import { RateLimitError } from '@src/domain/value/error/rate-limit-error.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { isCodexModel } from '@src/domain/value/settings-models/codex.ts';
import type { ProviderSpawn } from '@src/integration/ai/providers/_engine/spawn.ts';
import { runHeadlessSpawn } from '@src/integration/ai/providers/_engine/run-headless-spawn.ts';
import type { AttemptOutcome } from '@src/integration/ai/providers/_engine/attempt-outcome.ts';
import { classifySpawnExit } from '@src/integration/ai/providers/_engine/classify-spawn-exit.ts';
import {
  DEFAULT_BACKOFF_SCHEDULE,
  delayForRetry,
  sleepCancellable,
} from '@src/integration/ai/providers/_engine/rate-limit-backoff.ts';
import { writeTextAtomic } from '@src/integration/io/fs.ts';
import { persistSessionIdFile } from '@src/integration/ai/providers/_engine/persist-session-id.ts';
import { contextWindowFor } from '@src/integration/ai/providers/_engine/context-window.ts';
import { truncateField } from '@src/integration/ai/providers/_engine/truncate-debug-field.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';

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
 *   | effort: <level>                   | `-c model_reasoning_effort=<level>`                             |
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
 * Session id capture: codex emits JSONL meta events on stdout. On codex-cli 0.130.x the id
 * arrives as `thread_id` on the leading `{type:"thread.started"}` record (legacy `session_id` /
 * `sessionId` are still recognised). The adapter line-buffers stdout, picks the first id out,
 * and discards the rest of the stream (the body is read from the tempfile). The captured id is
 * what `codex exec resume <id>` accepts, so it round-trips through `session.resume`.
 *
 * Permissions: only the two locked profiles (READ_ONLY / FULL_AUTO) are supported, since
 * those cover every wired chain. Half-permission combos surface `InvalidStateError` —
 * fail loud beats silent surprise. Codex `exec` on v0.130.0 does not expose a `--search`
 * flag, so the headless adapter cannot currently translate `canAccessNetwork`; sessions run
 * without the native live-web-search tool even though the shared permission model keeps the
 * bit for cross-provider parity.
 *
 * Per-line debug events: the headless adapter publishes one
 * `{ type: 'log', level: 'debug', message: 'codex-provider: assistant' | 'tool_use' | 'tool_result' }`
 * event per recognised `item.completed` record on codex's JSONL stream. The mapping (best-effort
 * on codex-cli 0.130.x — re-audit on vendor bumps):
 *
 *   - `item.completed` with `item.type === 'agent_message'` → `assistant` event (`meta.text`
 *     pulled from `item.text`).
 *   - `item.completed` with `item.type === 'command_execution'` → `tool_use` event
 *     (`meta.tool = 'command_execution'`, `meta.args = item.command`).
 *   - `item.completed` with `item.type === 'function_call'` → `tool_use` event
 *     (`meta.tool = item.name`, `meta.args = item.arguments`).
 *   - `item.completed` with `item.type === 'function_call_output'` → `tool_result` event
 *     (`meta.tool = item.name | item.call_id`, `meta.status = 'ok' | 'error'`,
 *     `meta.preview = item.output`).
 *   - `thread.started`, `turn.started`, `turn.completed`, unknown / malformed lines: silently
 *     skipped — they are accounted for by the session-id / token-usage telemetry above.
 *
 * The bus → logger consumer (`createEventBusLogger`) honours `RALPHCTL_LOG_LEVEL`, so these
 * events stay invisible at the default `info` floor and only land in chain.log when an
 * operator explicitly bumps the floor to `debug`.
 *
 * Test seam: `spawn` is overridable so tests script stdout / stderr / exit code without
 * launching the real `codex` binary. `readFile` / `unlink` are also injectable for unit
 * tests that exercise the body-capture path without disk I/O.
 *
 * Docs:
 *   - https://developers.openai.com/codex/cli/reference (top-level + `exec` flags)
 *   - https://developers.openai.com/codex/noninteractive (`-o`, `--json`, stdin sentinel)
 *
 * Composition-root inputs ({@link CodexProviderDeps}) live in `_engine/` so the contract is
 * a port, not an implementation detail of this file.
 */

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
  // Forward `session.effort` verbatim via `-c model_reasoning_effort=<value>`. Codex's
  // documented levels are minimal | low | medium | high; the launcher floors xhigh/max to
  // high in `resolveEffort` before reaching the adapter, so any string that arrives here
  // should already be in-range. Codex itself rejects unknown levels — let it speak rather
  // than re-validate here (mirrors the custom-model arm policy).
  if (session.effort !== undefined) {
    args.push('-c', `model_reasoning_effort=${session.effort}`);
  }
  // Trailing `-` tells codex to read the prompt from stdin. Required when no positional
  // prompt arg is given — without it, codex hangs waiting for the arg.
  args.push('-');
  return Result.ok(args);
};

/**
 * Stale-resume detection. Codex persists each session as a "rollout"; after a crash / abort /
 * expiry the rollout can vanish, so a subsequent `codex exec resume <id>` exits non-zero with
 * "thread/resume failed: no rollout found for thread id … (code -32600)". The gen-eval loop
 * threads the prior round's session id as `session.resume`, so a lost rollout would otherwise
 * block the task on an evaluator/generator turn that never ran. We detect that exact failure
 * and fall back to a cold spawn instead.
 *
 * The two textual alternatives match the canonical message verbatim; `code -32600` is an
 * intentionally broad backstop (it is the generic JSON-RPC "Invalid Request" code, not unique to a
 * lost rollout). A spurious match only ever triggers ONE benign cold respawn — the prompt is
 * self-contained, so the cost is losing the in-thread conversation memory, never correctness — and
 * the `coldRetried` latch bounds it. Kept broad on purpose so a future codex build that drops the
 * textual wording but keeps the code still self-heals.
 */
const RESUME_STALE_RE = /no rollout found|thread\/resume failed|code -32600/i;

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
      const argsResult = buildCodexArgs(session, { outputFile });
      if (!argsResult.ok) return Result.error(argsResult.error) as Result<ProviderOutput, DomainError>;
      let args = argsResult.value;
      // Latch so the stale-resume cold fallback fires at most once per generate() call.
      let coldRetried = false;

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
                  // User cancel during the backoff sleep must surface as AbortError — the one
                  // error chains propagate transparently (CLAUDE.md §AbortError). InvalidStateError
                  // is classified as a recoverable turn error and would wrongly self-block the task.
                  // Mirrors the abort-on-exit shape in classify-spawn-exit.ts.
                  return Result.error(
                    new AbortError({
                      elementName: 'codex-provider',
                      reason: 'codex-provider: aborted by caller during rate-limit backoff',
                    })
                  ) as Result<ProviderOutput, DomainError>;
                }
              }
            }
            continue;
          }
          // Resume resilience: a `resume` spawn that fails because codex no longer has the
          // rollout ("no rollout found", code -32600) would otherwise block the task. Fall
          // back to a COLD spawn (no --resume) exactly once. Decrementing `attempt` keeps the
          // fallback from consuming a rate-limit slot; the `coldRetried` latch bounds it.
          //
          // Exempt an aborted run explicitly: a user cancel (Ctrl-C / TUI abort) must tear the run
          // down, not spawn fresh work a competitor may now own. Today an AbortError's message
          // wouldn't match RESUME_STALE_RE, so this is belt-and-braces — but it keeps the abort
          // guarantee independent of how the abort path happens to word its error.
          if (
            !coldRetried &&
            session.abortSignal?.aborted !== true &&
            session.resume !== undefined &&
            RESUME_STALE_RE.test(outcome.error.message)
          ) {
            coldRetried = true;
            deps.eventBus.publish({
              type: 'log',
              level: 'warn',
              message: 'codex-provider: resume thread not found — retrying cold (dropping --resume)',
              meta: { resume: String(session.resume) },
              at: IsoTimestamp.now(),
            });
            // Drop the stale resume id so buildCodexArgs takes the cold-start path. `delete`
            // on a spread copy (never the caller's session) — `exactOptionalPropertyTypes`
            // forbids re-setting `resume: undefined`, so omit the key entirely.
            const coldSession: AiSession = { ...session };
            delete (coldSession as { resume?: unknown }).resume;
            const coldArgs = buildCodexArgs(coldSession, { outputFile });
            if (coldArgs.ok) {
              args = coldArgs.value;
              attempt--;
              continue;
            }
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
 * Line-extract session-id / `model` / token-usage fields from codex's JSONL stdout. Returns
 * the residual tail (unterminated trailing chars). `onMeta` is invoked once per recognised
 * line carrying any of the fields; the caller dedupes (sessionId / model = first wins; usage
 * = last wins).
 *
 * Codex's `--json` stream is JSONL. On codex-cli 0.130.x the session id arrives on the leading
 * `{type:"thread.started", thread_id:"<uuid>"}` record — NOT a `session_id` field. We also keep
 * recognising the legacy `session_id` / `sessionId` keys (older / future builds, and forward
 * compat) so either shape populates the id. Token usage arrives on the trailing
 * `{type:"turn.completed", usage:{input_tokens, output_tokens, …}}` record. Schema-tolerant:
 * any unrecognised structure is skipped silently.
 *
 * The captured `thread_id` UUID is exactly what `codex exec resume <id>` accepts ("conversation/
 * session id (UUID) or thread name"), so it round-trips back through `session.resume` to continue
 * the conversation across gen-eval rounds.
 */
const consumeMetaLines = (
  buffer: string,
  onMeta: (update: CodexMetaUpdate) => void,
  onLine?: (obj: Record<string, unknown>) => void
): string => {
  let remaining = buffer;
  while (true) {
    const nl = remaining.indexOf('\n');
    if (nl === -1) return remaining;
    const line = remaining.slice(0, nl);
    remaining = remaining.slice(nl + 1);
    const trimmed = line.trim();
    if (trimmed.length === 0 || !trimmed.startsWith('{')) continue;
    let obj: Record<string, unknown>;
    try {
      // Why: codex stream records arrive line-by-line at high volume; downstream
      // `stringField` / `numberField` helpers narrowly type-check the fields we care
      // about (`thread_id`, `session_id`, `model`, `usage.*`). Unknown shapes are skipped.
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // non-JSON line — codex occasionally prints banner text alongside json records; skip
      continue;
    }
    // Per-line debug fan-out (assistant / tool_use / tool_result) BEFORE the meta extractors,
    // so a single `item.completed` record both updates meta accumulators (when applicable)
    // and surfaces as one debug event in chain.log.
    if (onLine !== undefined) onLine(obj);
    // `thread_id` is the 0.130.x field (on the `thread.started` record); `session_id` /
    // `sessionId` cover legacy / forward-compat builds. First non-empty id wins (deduped by
    // the caller), so listing `thread_id` first matches the stream order.
    const id = stringField(obj, 'thread_id', 'session_id', 'sessionId');
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
  }
};

/**
 * Emit one structured debug event per recognised codex `item.completed` record. See the
 * module-level comment for the shape mapping. Returns early when the JSON record is not an
 * `item.completed` envelope — `thread.started` / `turn.started` / `turn.completed` (and any
 * unknown line type) intentionally produce no event because they have no assistant / tool
 * payload to surface.
 */
const publishCodexStreamLineEvents = (eventBus: EventBus, obj: Record<string, unknown>): void => {
  if (stringField(obj, 'type') !== 'item.completed') return;
  const item = obj['item'];
  if (!isRecord(item)) return;
  const itemType = stringField(item, 'type');
  if (itemType === 'agent_message') {
    const text = truncateField(stringField(item, 'text'));
    if (text !== undefined) {
      eventBus.publish({
        type: 'log',
        level: 'debug',
        message: 'codex-provider: assistant',
        meta: { text },
        at: IsoTimestamp.now(),
      });
    }
    return;
  }
  if (itemType === 'command_execution') {
    const args = truncateField(stringField(item, 'command'));
    eventBus.publish({
      type: 'log',
      level: 'debug',
      message: 'codex-provider: tool_use',
      meta: {
        tool: 'command_execution',
        ...(args !== undefined ? { args } : {}),
      },
      at: IsoTimestamp.now(),
    });
    return;
  }
  if (itemType === 'function_call') {
    const tool = stringField(item, 'name') ?? '';
    const rawArgs = item['arguments'];
    const argsPreview = typeof rawArgs === 'string' ? rawArgs : safeJson(rawArgs);
    const args = truncateField(argsPreview);
    eventBus.publish({
      type: 'log',
      level: 'debug',
      message: 'codex-provider: tool_use',
      meta: {
        tool,
        ...(args !== undefined ? { args } : {}),
      },
      at: IsoTimestamp.now(),
    });
    return;
  }
  if (itemType === 'function_call_output') {
    const tool = stringField(item, 'name') ?? stringField(item, 'call_id') ?? '';
    const status = item['is_error'] === true || stringField(item, 'status') === 'error' ? 'error' : 'ok';
    const preview = truncateField(stringField(item, 'output'));
    eventBus.publish({
      type: 'log',
      level: 'debug',
      message: 'codex-provider: tool_result',
      meta: {
        tool,
        status,
        ...(preview !== undefined ? { preview } : {}),
      },
      at: IsoTimestamp.now(),
    });
  }
};

const safeJson = (v: unknown): string | undefined => {
  if (v === undefined || v === null) return undefined;
  try {
    const s = JSON.stringify(v);
    return s === '{}' || s === '[]' ? undefined : s;
  } catch {
    return undefined;
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

  // Bound once so onIdle's banner-show id and the classifier's banner-clear id match.
  const watchdogBannerId = `watchdog-codex-${String(child.pid ?? 'unknown')}`;

  // Codex `exec` reads the prompt from stdin; codex streams tokens to stdout so we attach a
  // line-buffering session-id sniffer and wait for `'exit'` (no need to wait for streams to
  // flush after exit — the session id is captured inline).
  let model: string | undefined;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  const { code, signal } = await runHeadlessSpawn({
    child,
    onStdout: (chunk) => {
      stdoutLineBuf = consumeMetaLines(
        stdoutLineBuf + chunk,
        (update) => {
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
          // Last-write-wins on usage — codex's `turn.completed` record carries the cumulative
          // figure; earlier records (thread.started / streaming chunks) report partials or nothing.
          if (update.inputTokens !== undefined) inputTokens = update.inputTokens;
          if (update.outputTokens !== undefined) outputTokens = update.outputTokens;
        },
        (obj) => publishCodexStreamLineEvents(deps.eventBus, obj)
      );
    },
    onStderr: (chunk) => {
      stderrBuf += chunk;
    },
    stdin: session.prompt,
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
        id: watchdogBannerId,
        tier: 'warn',
        message: `Watchdog killed stuck codex process${idleMs !== undefined ? ` (${String(Math.round(idleMs / 1000))}s idle)` : ''}`,
        at: IsoTimestamp.now(),
      });
    },
  });

  const onSuccess = async (): Promise<AttemptOutcome> => {
    let body: string;
    try {
      // Single-shot read of the codex output tempfile — no per-line in-process accumulation.
      // Preserve that: any future streaming variant must use an O(N) accumulator (see the
      // `bodyLines.push` + `.join('\n')` pattern in copilot/headless.ts). On SIGTERM-recovery
      // the tempfile may be partial or empty; bodyFile mirror simply writes what we have.
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
    // Persist captured session id as a sibling `sessionId` file. Codex emits the id as
    // `thread_id` on the leading `thread.started` JSONL record; missing → skip (no empty
    // marker). See persistSessionIdFile.
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
      // Emit one TokenUsageEvent per success spawn. Codex commonly omits token counts
      // from the JSONL records on v0.130.x; the event still fires so subscribers can correlate
      // sessionId → provider without inferring success from token-field absence.
      const window = contextWindowFor(model);
      const chainSessionId = session.chainSessionId;
      deps.eventBus.publish({
        type: 'token-usage',
        sessionId,
        ...(chainSessionId !== undefined ? { chainSessionId } : {}),
        provider: 'openai-codex',
        ...(model !== undefined ? { model } : {}),
        ...(inputTokens !== undefined ? { inputTokens } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {}),
        ...(window !== undefined ? { contextWindow: window } : {}),
        ...(session.role !== undefined ? { role: session.role } : {}),
        at: IsoTimestamp.now(),
      });
    }
    return {
      kind: 'success',
      output: {
        signalsFile: session.signalsFile,
        exitCode: code ?? 0,
        ...(sessionId !== undefined ? { sessionId } : {}),
      },
    };
  };

  return classifySpawnExit({
    session,
    exit: { code, signal },
    stderr: stderrBuf,
    rateLimitRe: RATE_LIMIT_RE,
    ...(sessionId !== undefined ? { capturedSessionId: sessionId } : {}),
    providerName: 'codex-provider',
    eventBus: deps.eventBus,
    watchdogBannerId,
    onSuccess,
  });
};

const defaultSpawn: ProviderSpawn = (command, args, options) =>
  crossPlatformSpawn(command, args, {
    stdio: [...options.stdio],
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
  }) as ChildProcessWithoutNullStreams;
