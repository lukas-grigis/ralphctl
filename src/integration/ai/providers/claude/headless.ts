import { Result } from '@src/domain/result.ts';
import type { HeadlessAiProvider } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import { isRecord } from '@src/integration/ai/providers/_engine/json-field.ts';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import type { HeadlessProviderDeps } from '@src/integration/ai/providers/_engine/headless-provider-deps.ts';
import { resolveWritableRoots } from '@src/integration/ai/providers/_engine/resolve-roots.ts';
import type { SessionPermissions } from '@src/integration/ai/providers/_engine/session-permissions.ts';
import type { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { isClaudeModel } from '@src/domain/value/settings-models/claude.ts';
import { validateModel } from '@src/integration/ai/providers/_engine/validate-model.ts';
import { createClaudeStreamParser } from '@src/integration/ai/providers/claude/parse-stream.ts';
import type { ClaudeStreamLine } from '@src/integration/ai/providers/_engine/claude-stream.ts';
import { type ProviderSpawn, defaultProviderSpawn } from '@src/integration/ai/providers/_engine/spawn.ts';
import {
  publishAssistantEvent,
  publishToolResultEvent,
  publishToolUseEvent,
} from '@src/integration/ai/providers/_engine/stream-debug-events.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import {
  createHeadlessProvider,
  emitTokenUsage,
  runProviderAttempt,
} from '@src/integration/ai/providers/_engine/run-provider-attempt.ts';

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
 * Composition-root inputs ({@link HeadlessProviderDeps}) live in `_engine/` so the contract is
 * a port shared with the sibling adapters, not an implementation detail of this file.
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

const PROVIDER_NAME = 'claude-provider';

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

interface ClaudeToolUse {
  readonly name: string;
  readonly input: unknown;
}

interface AssistantBlocks {
  readonly texts: readonly string[];
  readonly toolUses: readonly ClaudeToolUse[];
}

/**
 * Split one assistant line's `message.content[]` into its `text` blocks and its `tool_use`
 * blocks in stream order. Pure — every unrecognised or malformed block is skipped.
 */
const collectAssistantBlocks = (content: readonly unknown[]): AssistantBlocks => {
  const texts: string[] = [];
  const toolUses: ClaudeToolUse[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    const blockType = asString(block['type']);
    if (blockType === 'text') {
      const t = asString(block['text']);
      if (t !== undefined) texts.push(t);
    } else if (blockType === 'tool_use') {
      toolUses.push({ name: asString(block['name']) ?? '', input: block['input'] });
    }
  }
  return { texts, toolUses };
};

/**
 * One `assistant` event whose `meta.text` is the concatenation of every `text` block on the line,
 * plus one `tool_use` event per nested tool call (`args` omitted when the call carries no input).
 */
const publishAssistantLine = (eventBus: EventBus, content: readonly unknown[]): void => {
  const { texts, toolUses } = collectAssistantBlocks(content);
  publishAssistantEvent(eventBus, PROVIDER_NAME, texts.join('\n'));
  for (const tool of toolUses) {
    publishToolUseEvent(eventBus, PROVIDER_NAME, tool.name, previewArgs(tool.input));
  }
};

/** One `tool_result` event per `tool_result` block on a `type:"user"` line. */
const publishToolResults = (eventBus: EventBus, content: readonly unknown[]): void => {
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (asString(block['type']) !== 'tool_result') continue;
    const tool = asString(block['name']) ?? asString(block['tool_use_id']) ?? '';
    const status = block['is_error'] === true ? 'error' : 'ok';
    publishToolResultEvent(eventBus, PROVIDER_NAME, tool, status, previewToolResult(block['content']));
  }
};

/**
 * Per-line debug publisher. Unwraps Claude's stream-json envelope and dispatches the two
 * content-bearing line types to the emitters above:
 *
 *  - `type:"assistant"` → one `assistant` event plus one `tool_use` event per tool call.
 *  - `type:"user"` → one `tool_result` event per result block.
 *  - `type:"system"`, `type:"result"`, unknown / malformed lines: silently skipped — they are
 *    accounted for by other telemetry (system → init logging; result → token-usage event).
 *
 * See `_engine/stream-debug-events.ts` for the event envelope these share with codex / copilot.
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

  if (type === 'assistant') publishAssistantLine(eventBus, content);
  else publishToolResults(eventBus, content);
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
  const validated = validateModel(session.model, isClaudeModel, {
    entity: PROVIDER_NAME,
    attemptedAction: 'build argv',
    notKnownMessage: `claude-provider: '${session.model}' is not a known Claude model`,
  });
  if (!validated.ok) return Result.error(validated.error);
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

export const createClaudeProvider = (deps: HeadlessProviderDeps): HeadlessAiProvider => {
  const spawnFn: ProviderSpawn = deps.spawn ?? defaultProviderSpawn;
  const command = deps.command ?? 'claude';

  return createHeadlessProvider({
    providerSlug: 'claude',
    providerName: PROVIDER_NAME,
    resumeStaleRe: RESUME_STALE_RE,
    rateLimitRetries: deps.rateLimitRetries,
    eventBus: deps.eventBus,
    ...(deps.backoffSchedule !== undefined ? { backoffSchedule: deps.backoffSchedule } : {}),
    createGenerateContext: () => ({
      attempt: async (attemptSession) => {
        const built = buildClaudeArgs(attemptSession);
        if (!built.ok) return { kind: 'error', error: built.error };

        const parser = createClaudeStreamParser();
        const onLine = (line: ClaudeStreamLine): void => {
          parser.ingest(line);
          // Per-line debug fan-out, published DIRECTLY to the EventBus — no gate at this site. The
          // UI-floor filter lives in launch.ts's coalescing forwarder (applied at ingest against the
          // live log-level gate); the persistent events.ndjson sink records every event regardless of
          // that floor. `createEventBusLogger` is a producer, not a filter, and drops nothing here.
          publishStreamLineEvents(deps.eventBus, line);
        };

        return runProviderAttempt({
          spawnFn,
          command,
          args: built.value,
          session: attemptSession,
          resolveOn: 'close',
          // `cwd` is critical — the Claude Code CLI only auto-discovers `CLAUDE.md`, skills, agents,
          // and `.mcp.json` from the child's `process.cwd()`. Without this, the native context-file
          // pipeline silently misses and the AI runs without project guidance. See CLAUDE.md §Security.
          stdin: attemptSession.prompt,
          rateLimitRe: RATE_LIMIT_RE,
          onStdoutChunk: (chunk) => {
            parser.feed(chunk, onLine);
          },
          flush: () => {
            parser.flush(onLine);
          },
          getSessionId: () => parser.snapshot().sessionId,
          // Claude's `-p stream-json` mode reports quota errors in the stdout `result` envelope, not
          // on stderr. Feed the parsed body into the rate-limit haystack so a real throttle trips the
          // overnight backoff instead of hard-failing the round.
          getStdoutTail: () => {
            const body = parser.snapshot().body;
            return body.length > 0 ? body : undefined;
          },
          // `envelope.body` is sourced from `parser.snapshot()` in O(1) — the parser holds a single
          // string reassigned from the latest `result` event. No per-line concatenation in this adapter.
          getBody: () => Promise.resolve(Result.ok(parser.snapshot().body)),
          emitProviderTokenUsage: (sessionId) => {
            const env = parser.snapshot();
            // Absence of usage counters is honest: the result event may carry zero usage subkeys on
            // degenerate spawns or when the spawn was SIGTERM-recovered before the final result event.
            return emitTokenUsage(deps.eventBus, attemptSession, sessionId, {
              provider: 'claude-code',
              ...(env.model !== undefined ? { model: env.model } : {}),
              ...(env.usage.inputTokens !== undefined ? { inputTokens: env.usage.inputTokens } : {}),
              ...(env.usage.outputTokens !== undefined ? { outputTokens: env.usage.outputTokens } : {}),
              ...(env.usage.cacheReadTokens !== undefined ? { cacheReadTokens: env.usage.cacheReadTokens } : {}),
              ...(env.usage.cacheCreationTokens !== undefined
                ? { cacheCreationTokens: env.usage.cacheCreationTokens }
                : {}),
              // Live/per-turn snapshot from the LAST assistant turn — true current context-window
              // occupancy, distinct from the cumulative `*Tokens` above. Absent on codex/copilot and
              // on spawns where no assistant event carried usage.
              ...(env.liveUsage.inputTokens !== undefined ? { liveInputTokens: env.liveUsage.inputTokens } : {}),
              ...(env.liveUsage.cacheReadTokens !== undefined
                ? { liveCacheReadTokens: env.liveUsage.cacheReadTokens }
                : {}),
              ...(env.liveUsage.cacheCreationTokens !== undefined
                ? { liveCacheCreationTokens: env.liveUsage.cacheCreationTokens }
                : {}),
            });
          },
          providerName: PROVIDER_NAME,
          providerSlug: 'claude',
          eventBus: deps.eventBus,
          ...(deps.idleMs !== undefined ? { idleMs: deps.idleMs } : {}),
        });
      },
    }),
  });
};
