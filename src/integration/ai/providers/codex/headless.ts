import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type { HeadlessAiProvider } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import { RATE_LIMIT_SCAN_TAIL_CAP } from '@src/integration/ai/providers/_engine/bounded-tail.ts';
import { isRecord, numberField, stringField } from '@src/integration/ai/providers/_engine/json-field.ts';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import type { CodexProviderDeps } from '@src/integration/ai/providers/_engine/codex-provider-deps.ts';
import { resolveWritableRoots } from '@src/integration/ai/providers/_engine/resolve-roots.ts';
import type { SessionPermissions } from '@src/integration/ai/providers/_engine/session-permissions.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { isCodexModel } from '@src/domain/value/settings-models/codex.ts';
import { type ProviderSpawn, defaultProviderSpawn } from '@src/integration/ai/providers/_engine/spawn.ts';
import { DEFAULT_RATE_LIMIT_RE } from '@src/integration/ai/providers/_engine/classify-spawn-exit.ts';
import { truncateField } from '@src/integration/ai/providers/_engine/truncate-debug-field.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import {
  createHeadlessProvider,
  emitTokenUsage,
  runProviderAttempt,
} from '@src/integration/ai/providers/_engine/run-provider-attempt.ts';

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

/**
 * Pull the assistant text out of a codex `{type:"item.completed", item:{type:"agent_message"}}`
 * record. Used to feed the rate-limit classifier's haystack — codex prints a quota throttle in
 * the agent_message body. Returns undefined for any other record shape.
 */
const agentMessageText = (obj: Record<string, unknown>): string | undefined => {
  if (stringField(obj, 'type') !== 'item.completed') return undefined;
  const item = obj['item'];
  if (!isRecord(item) || stringField(item, 'type') !== 'agent_message') return undefined;
  return stringField(item, 'text');
};

export const createCodexProvider = (deps: CodexProviderDeps): HeadlessAiProvider => {
  const spawnFn: ProviderSpawn = deps.spawn ?? defaultProviderSpawn;
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

  return createHeadlessProvider({
    providerSlug: 'codex',
    providerName: 'codex-provider',
    resumeStaleRe: RESUME_STALE_RE,
    rateLimitRetries: deps.rateLimitRetries,
    eventBus: deps.eventBus,
    ...(deps.backoffSchedule !== undefined ? { backoffSchedule: deps.backoffSchedule } : {}),
    createGenerateContext: () => {
      // One tempfile per generate() call, shared across all retry attempts so a rate-limit
      // retry reuses the same -o path without leaving orphan files. Cleaned up in cleanup().
      const outputFile = mkTempPath();
      return {
        attempt: async (attemptSession) => {
          const built = buildCodexArgs(attemptSession, { outputFile });
          if (!built.ok) return { kind: 'error', error: built.error };

          let sessionId: string | undefined;
          let model: string | undefined;
          let inputTokens: number | undefined;
          let outputTokens: number | undefined;
          // Accumulate codex's `agent_message` text so the rate-limit classifier can scan it
          // alongside stderr — codex surfaces a quota throttle in the agent_message body,
          // not always on stderr. Capped to bound memory on a long session.
          let agentMessageTail = '';
          let stdoutLineBuf = '';

          const onMeta = (update: CodexMetaUpdate): void => {
            if (update.sessionId !== undefined && sessionId === undefined) {
              sessionId = update.sessionId;
            }
            if (update.model !== undefined && model === undefined) {
              model = update.model;
            }
            // Last-write-wins on usage — codex's `turn.completed` record carries the cumulative
            // figure; earlier records (thread.started / streaming chunks) report partials or nothing.
            if (update.inputTokens !== undefined) inputTokens = update.inputTokens;
            if (update.outputTokens !== undefined) outputTokens = update.outputTokens;
          };
          const onLine = (obj: Record<string, unknown>): void => {
            publishCodexStreamLineEvents(deps.eventBus, obj);
            const text = agentMessageText(obj);
            if (text !== undefined) {
              agentMessageTail = `${agentMessageTail}${agentMessageTail.length > 0 ? '\n' : ''}${text}`.slice(
                -RATE_LIMIT_SCAN_TAIL_CAP
              );
            }
          };

          return runProviderAttempt({
            spawnFn,
            command,
            args: built.value,
            session: attemptSession,
            resolveOn: 'exit',
            // `cwd` is set in addition to codex's argv `-C` so context-file autoload works on
            // `exec resume` (which does not accept `-C`) and is consistent with the other adapters.
            // See CLAUDE.md §Security.
            stdin: attemptSession.prompt,
            rateLimitRe: DEFAULT_RATE_LIMIT_RE,
            onStdoutChunk: (chunk) => {
              stdoutLineBuf = consumeMetaLines(stdoutLineBuf + chunk, onMeta, onLine);
            },
            // Flush any partial line remaining in the buffer — codex may terminate without a
            // trailing newline. Appending a synthetic '\n' forces the partial through the parser.
            flush: () => {
              if (stdoutLineBuf.length > 0) {
                consumeMetaLines(stdoutLineBuf + '\n', onMeta, onLine);
              }
            },
            getSessionId: () => sessionId,
            // Codex reports a quota throttle in the agent_message body, not always on stderr.
            // Feed the accumulated tail into the rate-limit haystack so it trips the backoff.
            getStdoutTail: () => (agentMessageTail.length > 0 ? agentMessageTail : undefined),
            // Single-shot read of the codex output tempfile — no per-line in-process accumulation.
            // On SIGTERM-recovery the tempfile may be partial or empty.
            getBody: async () => {
              try {
                return Result.ok(await readFile(outputFile));
              } catch (err) {
                return Result.error(
                  new InvalidStateError({
                    entity: 'codex-provider',
                    currentState: 'output-capture',
                    attemptedAction: 'read tempfile',
                    message: `codex-provider: failed to read output tempfile: ${err instanceof Error ? err.message : String(err)}`,
                  })
                );
              }
            },
            emitProviderTokenUsage: (sessionId_) => {
              // Codex commonly omits token counts from the JSONL records on v0.130.x; the event
              // still fires so subscribers can correlate sessionId → provider without inferring
              // success from token-field absence.
              emitTokenUsage(deps.eventBus, attemptSession, sessionId_, {
                provider: 'openai-codex',
                ...(model !== undefined ? { model } : {}),
                ...(inputTokens !== undefined ? { inputTokens } : {}),
                ...(outputTokens !== undefined ? { outputTokens } : {}),
              });
            },
            providerName: 'codex-provider',
            providerSlug: 'codex',
            eventBus: deps.eventBus,
            ...(deps.idleMs !== undefined ? { idleMs: deps.idleMs } : {}),
          });
        },
        cleanup: () => unlink(outputFile),
      };
    },
  });
};
