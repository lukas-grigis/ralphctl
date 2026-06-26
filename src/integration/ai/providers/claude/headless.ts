import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { crossPlatformSpawn } from '@src/integration/io/cross-platform-spawn.ts';
import { Result } from '@src/domain/result.ts';
import type { HeadlessAiProvider, ProviderOutput } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import { STDERR_TAIL_CAP, createBoundedTail } from '@src/integration/ai/providers/_engine/bounded-tail.ts';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import type { ClaudeProviderDeps } from '@src/integration/ai/providers/_engine/claude-provider-deps.ts';
import { resolveWritableRoots } from '@src/integration/ai/providers/_engine/resolve-roots.ts';
import type { SessionPermissions } from '@src/integration/ai/providers/_engine/session-permissions.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { isClaudeModel } from '@src/domain/value/settings-models/claude.ts';
import { isSuspendedModel, suspendedModelMessage } from '@src/domain/value/settings-models/suspended-models.ts';
import { createClaudeStreamParser } from '@src/integration/ai/providers/claude/parse-stream.ts';
import type { ClaudeStreamLine } from '@src/integration/ai/providers/_engine/claude-stream.ts';
import type { ProviderSpawn } from '@src/integration/ai/providers/_engine/spawn.ts';
import { runHeadlessSpawn } from '@src/integration/ai/providers/_engine/run-headless-spawn.ts';
import { runWithRateLimitRetry } from '@src/integration/ai/providers/_engine/run-with-rate-limit-retry.ts';
import { writeTextAtomic } from '@src/integration/io/fs.ts';
import { persistSessionIdFile } from '@src/integration/ai/providers/_engine/persist-session-id.ts';
import { contextWindowFor } from '@src/integration/ai/providers/_engine/context-window.ts';
import { truncateField } from '@src/integration/ai/providers/_engine/truncate-debug-field.ts';
import type { AttemptOutcome } from '@src/integration/ai/providers/_engine/attempt-outcome.ts';
import { classifySpawnExit } from '@src/integration/ai/providers/_engine/classify-spawn-exit.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';

/**
 * Real {@link HeadlessAiProvider} backed by the Claude Code CLI.
 *
 * Output handling — file-based contract: claude is invoked with
 * `-p --verbose --output-format stream-json`, which emits one JSON object per line as the
 * session progresses:
 *
 *   {"type":"system","subtype":"init","session_id":"…","model":"…", …}
 *   {"type":"assistant","message":{…},"session_id":"…"}
 *   {"type":"result","subtype":"success","result":"<assistant text>","session_id":"…", …}
 *
 * `--verbose` is required by the CLI in non-interactive `-p` mode when `--output-format` is
 * `stream-json`; without it the CLI errors out. Token streaming on stdout is what the
 * idle-stdout watchdog at `src/integration/ai/providers/_engine/idle-watchdog.ts` relies on
 * to distinguish a wedged child from a healthy long-running session — plain `json` buffered
 * everything until end-of-session and SIGTERM'd healthy children mid-task.
 *
 * After `'close'` fires (stdio drained), the parser's accumulated envelope (body = the `result`
 * event's `.result` string; session_id = earliest seen on any line) is read out. Per the
 * audit-[09] contract, the AI writes `signals.json` directly via its Write tool into
 * `session.outputDir`; the harness validates that file post-spawn — the provider never writes
 * `signals.json` itself. When `session.bodyFile` is set, the body is mirrored there for
 * forensic capture (empty-proposal diagnostics).
 *
 * Rate-limit detection scans stderr AND the parsed stdout `result` body against a broadened
 * quota regex; on match the shared retry seam (`run-with-rate-limit-retry.ts`) retries up to
 * `rateLimitRetries` then surfaces `RateLimitError`. `abortSignal` propagates to SIGTERM
 * — the harness only kills the child when the user cancels; there is no wall-clock timeout
 * because an implement session can legitimately run for hours.
 *
 * Translation table (intent → Claude CLI flag):
 *
 *   | AiSession field                                         | Claude flag                                                  |
 *   | ------------------------------------------------------- | ------------------------------------------------------------ |
 *   | model: <ClaudeModel>                                    | --model <model>                                              |
 *   | permissions {autoApprove,canModifyRepoFiles,canRunShell}=true | --permission-mode bypassPermissions                          |
 *   | permissions read-only (canModifyRepoFiles=false, …)           | --permission-mode bypassPermissions --disallowedTools <list> |
 *   | additionalRoots: [a, b]                                 | --add-dir a --add-dir b                                      |
 *   | resume: id                                              | --resume id                                                  |
 *   | effort: <level>                                         | --effort <level>                                             |
 *
 * Test seam: `spawn` is overridable so tests script stdout / stderr / exit code without
 * actually launching `claude`. Defaults to `node:child_process.spawn`.
 *
 * Docs: https://code.claude.com/docs/en/cli-reference (`--model`, `--add-dir`,
 * `--permission-mode`, `--output-format`, `--resume`).
 *
 * Composition-root inputs ({@link ClaudeProviderDeps}) live in `_engine/` so the contract is
 * a port, not an implementation detail of this file.
 */

/**
 * Rate-limit / quota detection. Broadened past the bare `/rate.?limit/i` because Claude reports
 * a daily-quota throttle with wording that never contains the literal "rate limit": "usage limit
 * reached", the "5-hour limit" window, the API's `overloaded_error` type, and a bare `429`. The
 * haystack is stderr PLUS the parsed stdout `result` envelope body (claude's `-p stream-json`
 * mode reports quota in the stdout result, not on stderr) — see classifySpawnExit's `stdoutTail`.
 */
const RATE_LIMIT_RE = /rate.?limit|usage limit reached|\b5-hour limit\b|overloaded_error|429/i;

/**
 * Cold-start fallback trigger: Claude rejects a `--resume <id>` whose session it no longer has
 * with "No conversation found with session ID". The shared retry seam drops `--resume` for one
 * cold respawn (latched) rather than hard-failing the round on a dead session id. Conservative —
 * matches the canonical wording only.
 */
const RESUME_STALE_RE = /No conversation found with session ID/i;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

const asString = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/**
 * Stringify a tool's `input` object into a one-line preview suitable for chain.log. JSON
 * encoding keeps array / nested-object shapes readable; we never feed multi-line previews into
 * the debug stream because the bus → logger pipeline writes one record per call.
 */
const previewArgs = (input: unknown): string | undefined => {
  if (input === undefined || input === null) return undefined;
  if (typeof input === 'string') return input;
  try {
    const json = JSON.stringify(input);
    return json === undefined || json === '{}' || json === '[]' ? undefined : json;
  } catch {
    return undefined;
  }
};

/**
 * Coerce a `tool_result` block's `content` (Claude permits either a plain string or an array of
 * content sub-blocks each with a `text` field) into a single preview string.
 */
const previewToolResult = (content: unknown): string | undefined => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const part of content) {
      if (isRecord(part)) {
        const t = asString(part['text']);
        if (t !== undefined) texts.push(t);
      }
    }
    if (texts.length > 0) return texts.join('\n');
  }
  return undefined;
};

/**
 * Per-line debug publisher. Inspects Claude's stream-json envelope and fans out one
 * `{ type: 'log', level: 'debug' }` event per recognised content block:
 *
 *  - `type:"assistant"` lines: emit ONE `claude-provider: assistant` event whose `meta.text` is
 *    the concatenation of every `text` block in `message.content[]`, truncated to 120 chars.
 *    Tool-use blocks nested in the same line each surface as their own `tool_use` event with
 *    `{ tool: <name>, args: <truncated JSON preview> }` (the `args` key is omitted when the
 *    block carries no input — matches the contract "omit args when none").
 *  - `type:"user"` lines: emit one `tool_result` event per `tool_result` content block, with
 *    `{ tool: <name | tool_use_id>, status: 'ok' | 'error', preview: <truncated content> }`.
 *  - `type:"system"`, `type:"result"`, unknown / malformed lines: silently skipped — they are
 *    accounted for by other telemetry (system → init logging; result → token-usage event).
 *
 * These events are published DIRECTLY to the EventBus — there is no producer-side gate here.
 * `createEventBusLogger` is a producer that *publishes* `log` AppEvents, not a filter, so it does
 * not drop anything emitted at this site. The only UI-floor gate is the coalescing forwarder in
 * `launch.ts`, which applies the live log-level floor at ingest before the TUI ever sees a line.
 * The persistent events.ndjson sink writes every event here verbatim, regardless of the UI floor.
 */
const publishStreamLineEvents = (eventBus: EventBus, line: ClaudeStreamLine): void => {
  const json = line.json;
  if (json === undefined) return;
  const type = asString(json['type']);
  if (type !== 'assistant' && type !== 'user') return;

  const message = json['message'];
  if (!isRecord(message)) return;
  const content = message['content'];
  if (!Array.isArray(content)) return;

  if (type === 'assistant') {
    const texts: string[] = [];
    const toolUses: Array<{ readonly name: string; readonly input: unknown }> = [];
    for (const block of content) {
      if (!isRecord(block)) continue;
      const blockType = asString(block['type']);
      if (blockType === 'text') {
        const t = asString(block['text']);
        if (t !== undefined) texts.push(t);
      } else if (blockType === 'tool_use') {
        const name = asString(block['name']) ?? '';
        toolUses.push({ name, input: block['input'] });
      }
    }
    if (texts.length > 0) {
      const text = truncateField(texts.join('\n'));
      if (text !== undefined) {
        eventBus.publish({
          type: 'log',
          level: 'debug',
          message: 'claude-provider: assistant',
          meta: { text },
          at: IsoTimestamp.now(),
        });
      }
    }
    for (const tool of toolUses) {
      const args = truncateField(previewArgs(tool.input));
      eventBus.publish({
        type: 'log',
        level: 'debug',
        message: 'claude-provider: tool_use',
        meta: {
          tool: tool.name,
          ...(args !== undefined ? { args } : {}),
        },
        at: IsoTimestamp.now(),
      });
    }
    return;
  }

  // type === 'user' — emit one event per tool_result block.
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (asString(block['type']) !== 'tool_result') continue;
    const tool = asString(block['name']) ?? asString(block['tool_use_id']) ?? '';
    const status = block['is_error'] === true ? 'error' : 'ok';
    const preview = truncateField(previewToolResult(block['content']));
    eventBus.publish({
      type: 'log',
      level: 'debug',
      message: 'claude-provider: tool_result',
      meta: {
        tool,
        status,
        ...(preview !== undefined ? { preview } : {}),
      },
      at: IsoTimestamp.now(),
    });
  }
};

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
 *    post-task-verify layer, not at the per-tool prompt.
 *
 * Docs: https://code.claude.com/docs/en/agent-sdk/permissions
 *  - bypassPermissions auto-approves every tool; `allowedTools` does NOT constrain it.
 *  - `disallowedTools` is a deny rule that overrides every other allow, including bypass.
 */

/**
 * Claude Code tool names. Kept as literal lists so a typo here = compile-time error in tests.
 *
 * `TOOL_EDIT` covers tools that modify EXISTING files (`Edit` / `MultiEdit` / `NotebookEdit`).
 * The `Write` tool stays open under every profile — the audit-[09] contract requires the AI
 * to land `signals.json` in `outputDir` via `Write`. Path scope (cwd + --add-dir) controls
 * which files `Write` can touch.
 */
const TOOL_EDIT = ['Edit', 'MultiEdit', 'NotebookEdit'] as const;
const TOOL_SHELL = ['Bash'] as const;
const TOOL_NETWORK = ['WebFetch', 'WebSearch'] as const;

/**
 * Translate {@link SessionPermissions} into the comma-separated `--disallowedTools` deny list.
 * Returns an empty array when every gate is open (full-auto) — caller skips the flag entirely.
 */
const disallowedToolsFor = (p: SessionPermissions): readonly string[] => {
  const denied: string[] = [];
  if (!p.canModifyRepoFiles) denied.push(...TOOL_EDIT);
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
  // Catalog-valid but temporarily suspended server-side (see suspended-models.ts) — fail fast
  // with a clear message rather than dispatching a --model the provider will reject opaquely.
  if (isSuspendedModel(session.model)) {
    return Result.error(
      new InvalidStateError({
        entity: 'claude-provider',
        currentState: 'model-suspended',
        attemptedAction: 'build argv',
        message: suspendedModelMessage(session.model),
      })
    );
  }
  // `-p` is the print-mode flag — without it `claude` launches its interactive TUI and the
  // stdin-piped prompt is silently discarded. v1 hit the same gotcha; mirror the fix here.
  // `--verbose` is required alongside `--output-format stream-json` in non-interactive `-p`
  // mode; the CLI rejects stream-json without it. stream-json itself is required so the
  // idle-stdout watchdog has a real liveness signal across multi-minute sessions.
  const args: string[] = ['-p', '--verbose', '--output-format', 'stream-json', '--model', session.model];
  args.push('--permission-mode', 'bypassPermissions');
  const denied = disallowedToolsFor(session.permissions);
  if (denied.length > 0) {
    args.push('--disallowedTools', denied.join(','));
  }
  // Auto-mount `outputDir` alongside declared additionalRoots so the AI's Write tool can
  // land `signals.json` (the audit-[09] envelope) when outputDir lives outside cwd. See
  // resolve-roots.ts for the de-dup rules.
  for (const root of resolveWritableRoots(session)) {
    args.push('--add-dir', String(root));
  }
  if (session.resume !== undefined) {
    args.push('--resume', String(session.resume));
  }
  // Forward `session.effort` verbatim. The Claude CLI's `--effort` flag rejects unknown
  // levels — let it speak for itself rather than re-validate here (mirrors the custom-model
  // arm, where any non-empty string is forwarded and validation is the binary's job).
  if (session.effort !== undefined) {
    args.push('--effort', session.effort);
  }
  return Result.ok(args);
};

export const createClaudeProvider = (deps: ClaudeProviderDeps): HeadlessAiProvider => {
  const spawnFn: ProviderSpawn = deps.spawn ?? defaultSpawn;
  const command = deps.command ?? 'claude';

  return {
    async generate(session) {
      // The shared retry seam owns the loop, backoff, banners, abort-during-backoff, the
      // session-resume rebuild (so a 429 retry passes `--resume <id>`), and the stale-resume
      // cold fallback. The per-attempt closure builds argv from the CURRENT session, so a
      // resumed retry naturally emits `--resume`. buildClaudeArgs validation surfaces up front.
      const argsResult = buildClaudeArgs(session);
      if (!argsResult.ok) return Result.error(argsResult.error) as Result<ProviderOutput, DomainError>;

      return runWithRateLimitRetry({
        session,
        rateLimitRetries: deps.rateLimitRetries,
        ...(deps.backoffSchedule !== undefined ? { backoffSchedule: deps.backoffSchedule } : {}),
        eventBus: deps.eventBus,
        providerSlug: 'claude',
        providerName: 'claude-provider',
        resumeStaleRe: RESUME_STALE_RE,
        attempt: async (attemptSession) => {
          const built = buildClaudeArgs(attemptSession);
          if (!built.ok) return { kind: 'error', error: built.error };
          return spawnAttempt({ deps, spawnFn, command, args: built.value, session: attemptSession });
        },
      });
    },
  };
};

interface SpawnAttemptArgs {
  readonly deps: ClaudeProviderDeps;
  readonly spawnFn: ProviderSpawn;
  readonly command: string;
  readonly args: readonly string[];
  readonly session: AiSession;
}

/**
 * One spawn attempt: launch `claude`, write prompt, stream stdout JSONL through the
 * stream-json parser, then delegate exit classification to `classifySpawnExit` (decides
 * success / rate-limit / abort / signals-recovery / hard-fail uniformly across the three
 * adapters). Per-provider success block (token-usage publish, persistSessionIdFile,
 * optional bodyFile mirror) lives in the `onSuccess` closure passed to the classifier —
 * the closure runs on `code === 0` AND on signals-present recovery, so a watchdog SIGTERM
 * that landed after the AI completed its work still produces a success.
 *
 * The `envelope.body` string goes out of scope at function return — never retained on a
 * domain entity.
 */
const spawnAttempt = async (input: SpawnAttemptArgs): Promise<AttemptOutcome> => {
  const { deps, spawnFn, command, args, session } = input;
  // `cwd` is critical — the Claude Code CLI only auto-discovers `CLAUDE.md`, skills, agents,
  // and `.mcp.json` from the child's `process.cwd()`. Without this, the native context-file
  // pipeline silently misses and the AI runs without project guidance.
  // See CLAUDE.md §Security — "Cwd is the repo because Claude / Copilot / Codex only
  // auto-discover their context file from cwd."
  const child = spawnFn(command, args, {
    stdio: ['pipe', 'pipe', 'pipe'] as const,
    cwd: String(session.cwd),
  });
  const parser = createClaudeStreamParser();
  const stderrTail = createBoundedTail(STDERR_TAIL_CAP);

  const onLine = (line: ClaudeStreamLine): void => {
    parser.ingest(line);
    // Per-line debug fan-out, published DIRECTLY to the EventBus — no gate at this site. The
    // UI-floor filter lives in launch.ts's coalescing forwarder (applied at ingest against the
    // live log-level gate); the persistent events.ndjson sink records every event regardless of
    // that floor. `createEventBusLogger` is a producer, not a filter, and drops nothing here.
    publishStreamLineEvents(deps.eventBus, line);
  };

  // Bound once so the onIdle banner-show id and the classifier's banner-clear id match.
  const watchdogBannerId = `watchdog-claude-${String(child.pid ?? 'unknown')}`;

  // Wait for the child to fully `'close'` — NOT just `'exit'`. `'exit'` can fire before the
  // final stdout chunk has been delivered to our listener; `'close'` guarantees the streams
  // have flushed. v1 uses the same event for the same reason.
  //
  // No wall-clock timeout: implement sessions can legitimately run for hours. The idle-stdout
  // watchdog (installed inside runHeadlessSpawn) handles the "stuck child" failure mode, and
  // `session.abortSignal` (Ctrl-C / TUI) threads through the same kill ladder.
  const { code, signal } = await runHeadlessSpawn({
    child,
    onStdout: (chunk) => parser.feed(chunk, onLine),
    onStderr: (chunk) => {
      stderrTail.append(chunk);
    },
    stdin: session.prompt,
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
      deps.eventBus.publish({
        type: 'banner-show',
        id: watchdogBannerId,
        tier: 'warn',
        message: `Watchdog killed stuck claude process${idleMs !== undefined ? ` (${String(Math.round(idleMs / 1000))}s idle)` : ''}`,
        at: IsoTimestamp.now(),
      });
    },
  });
  parser.flush(onLine);

  // `envelope.body` is sourced from `parser.snapshot()` in O(1) — the parser holds a single
  // string reassigned from the latest `result` event. No per-line concatenation in this
  // adapter; preserve that invariant.
  const envelope = parser.snapshot();

  const onSuccess = async (): Promise<AttemptOutcome> => {
    if (envelope.sessionId !== undefined) {
      deps.eventBus.publish({
        type: 'log',
        level: 'debug',
        message: 'claude-provider: session id captured',
        meta: { sessionId: envelope.sessionId },
        at: IsoTimestamp.now(),
      });
      // Emit one TokenUsageEvent per success spawn — only when we have a sessionId
      // (downstream subscribers correlate by it). Absence of usage counters is honest: the
      // result event may carry zero usage subkeys on degenerate spawns or when the spawn
      // was SIGTERM-recovered before the final result event landed.
      const window = contextWindowFor(envelope.model);
      const chainSessionId = session.chainSessionId;
      deps.eventBus.publish({
        type: 'token-usage',
        sessionId: envelope.sessionId,
        ...(chainSessionId !== undefined ? { chainSessionId } : {}),
        provider: 'claude-code',
        ...(envelope.model !== undefined ? { model: envelope.model } : {}),
        ...(envelope.usage.inputTokens !== undefined ? { inputTokens: envelope.usage.inputTokens } : {}),
        ...(envelope.usage.outputTokens !== undefined ? { outputTokens: envelope.usage.outputTokens } : {}),
        ...(envelope.usage.cacheReadTokens !== undefined ? { cacheReadTokens: envelope.usage.cacheReadTokens } : {}),
        ...(envelope.usage.cacheCreationTokens !== undefined
          ? { cacheCreationTokens: envelope.usage.cacheCreationTokens }
          : {}),
        // Live/per-turn snapshot from the LAST assistant turn — true current context-window
        // occupancy, distinct from the cumulative `*Tokens` above. Absent on copilot/codex and
        // on spawns where no assistant event carried usage.
        ...(envelope.liveUsage.inputTokens !== undefined ? { liveInputTokens: envelope.liveUsage.inputTokens } : {}),
        ...(envelope.liveUsage.cacheReadTokens !== undefined
          ? { liveCacheReadTokens: envelope.liveUsage.cacheReadTokens }
          : {}),
        ...(envelope.liveUsage.cacheCreationTokens !== undefined
          ? { liveCacheCreationTokens: envelope.liveUsage.cacheCreationTokens }
          : {}),
        ...(window !== undefined ? { contextWindow: window } : {}),
        ...(session.role !== undefined ? { role: session.role } : {}),
        at: IsoTimestamp.now(),
      });
    }
    // audit-[09]: the AI writes `signals.json` directly via its Write tool into
    // `session.outputDir`; the harness validates it post-spawn. The provider never writes
    // signals.json itself — every leaf consumes the contract path.
    // Persist captured session id as a sibling `sessionId` file so `--resume` / forensic
    // re-attach works without parsing chain.log. Skipped when the stream never carried an id
    // (process crashed mid-init) — see persistSessionIdFile for the contract.
    const sidWrote = await persistSessionIdFile(session.signalsFile, envelope.sessionId);
    if (sidWrote !== undefined && !sidWrote.ok) {
      deps.eventBus.publish({
        type: 'log',
        level: 'warn',
        message: `claude-provider: failed to write sessionId file — resume re-attach may need log parsing`,
        meta: { error: sidWrote.error.message },
        at: IsoTimestamp.now(),
      });
    }
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
        exitCode: code ?? 0,
        ...(envelope.sessionId !== undefined ? { sessionId: envelope.sessionId } : {}),
      },
    };
  };

  return classifySpawnExit({
    session,
    exit: { code, signal },
    stderr: stderrTail.value(),
    rateLimitRe: RATE_LIMIT_RE,
    // Claude's `-p stream-json` mode reports quota errors in the stdout `result` envelope, not
    // on stderr. Feed the parsed body into the rate-limit haystack so a real throttle trips the
    // overnight backoff instead of hard-failing the round.
    ...(envelope.body.length > 0 ? { stdoutTail: envelope.body } : {}),
    ...(envelope.sessionId !== undefined ? { capturedSessionId: envelope.sessionId } : {}),
    providerName: 'claude-provider',
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
