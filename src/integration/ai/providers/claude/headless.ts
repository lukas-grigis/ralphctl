import { Result } from '@src/domain/result.ts';
import type { HeadlessAiProvider } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import { isRecord, recordField, stringField } from '@src/integration/ai/providers/_engine/json-field.ts';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import type { HeadlessProviderDeps } from '@src/integration/ai/providers/_engine/headless-provider-deps.ts';
import { resolveWritableRoots } from '@src/integration/ai/providers/_engine/resolve-roots.ts';
import type { SessionPermissions } from '@src/integration/ai/providers/_engine/session-permissions.ts';
import type { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { isClaudeModel } from '@src/domain/value/settings-models/claude.ts';
import { validateModel } from '@src/integration/ai/providers/_engine/validate-model.ts';
import { createClaudeStreamParser } from '@src/integration/ai/providers/claude/parse-stream.ts';
import type { ClaudeStreamLine } from '@src/integration/ai/providers/_engine/claude-stream.ts';
import {
  publishAssistantEvent,
  publishToolResultEvent,
  publishToolUseEvent,
  previewJson,
} from '@src/integration/ai/providers/_engine/stream-debug-events.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import {
  createHeadlessProvider,
  runProviderAttempt,
} from '@src/integration/ai/providers/_engine/run-provider-attempt.ts';

/**
 * {@link HeadlessAiProvider} backed by the Claude Code CLI. Permission rationale lives in
 * `.claude/docs/SECURITY.md`.
 *
 *   | AiSession field             | Claude flag                                                  |
 *   | --------------------------- | ------------------------------------------------------------ |
 *   | (always)                    | `-p --verbose --output-format stream-json`                   |
 *   | model                       | `--model <model>`                                            |
 *   | permissions full-auto       | `--permission-mode bypassPermissions`                        |
 *   | permissions (any gate shut) | `--permission-mode bypassPermissions --disallowedTools <list>` |
 *   | additionalRoots + outputDir | `--add-dir <root>` per root                                  |
 *   | resume: id                  | `--resume id`                                                |
 *   | effort: <level>             | `--effort <level>` + `CLAUDE_CODE_EFFORT_LEVEL=<level>`      |
 *   | role: evaluator             | `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`                          |
 *   | prompt                      | piped to stdin                                               |
 *
 * stream-json (not `json`) is what gives the idle watchdog a liveness signal: `json` buffers
 * everything until the session ends, so the watchdog killed healthy long sessions.
 *
 * Docs: https://code.claude.com/docs/en/cli-reference
 */

// Broader than `/rate.?limit/`: Claude's quota wording never says "rate limit", and `-p stream-json`
// reports it in the stdout `result` body rather than on stderr.
const RATE_LIMIT_RE = /rate.?limit|usage limit reached|\b5-hour limit\b|overloaded_error|\b429\b/i;

const RESUME_STALE_RE = /No conversation found with session ID/i;

const PROVIDER_NAME = 'claude-provider';

/**
 * Per-spawn environment overlay.
 *  - Claude Code 2.1.302 turned fork subagents on in `-p`; off keeps cost bounded and the read-only
 *    gate unforked.
 *  - `CLAUDE_CODE_EFFORT_LEVEL` outranks `--effort`, so an operator's exported value would silently
 *    override every effort ralphctl resolves; pinning it to the same level makes the flag stick.
 *  - Auto memory is shared by every worktree of the repo, so the evaluator side runs without it to
 *    stay a fresh-context judge; the generator keeps the operator's memory.
 * Docs: https://code.claude.com/docs/en/env-vars, https://code.claude.com/docs/en/memory
 */
const claudeHeadlessEnv = (session: AiSession): Readonly<Record<string, string>> => ({
  CLAUDE_CODE_FORK_SUBAGENT: '0',
  ...(session.effort !== undefined ? { CLAUDE_CODE_EFFORT_LEVEL: session.effort } : {}),
  ...(session.role === 'evaluator' ? { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' } : {}),
});

// One-line previews only: the bus → logger pipeline writes one record per call.
const previewArgs = (input: unknown): string | undefined => (typeof input === 'string' ? input : previewJson(input));

/** A `tool_result` block's `content` is either a string or an array of `{ text }` sub-blocks. */
const previewToolResult = (content: unknown): string | undefined => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const texts = content.filter(isRecord).flatMap((part) => stringField(part, 'text') ?? []);
  return texts.length > 0 ? texts.join('\n') : undefined;
};

/**
 * One `assistant` event joining every `text` block on the line, then one `tool_use` event per
 * `tool_use` block (in stream order).
 */
const publishAssistantLine = (eventBus: EventBus, content: readonly unknown[]): void => {
  const blocks = content.filter(isRecord);
  const texts = blocks.flatMap((b) => (stringField(b, 'type') === 'text' ? (stringField(b, 'text') ?? []) : []));
  publishAssistantEvent(eventBus, PROVIDER_NAME, texts.join('\n'));
  for (const block of blocks) {
    if (stringField(block, 'type') !== 'tool_use') continue;
    publishToolUseEvent(eventBus, PROVIDER_NAME, stringField(block, 'name') ?? '', previewArgs(block['input']));
  }
};

/** One `tool_result` event per `tool_result` block on a `type:"user"` line. */
const publishToolResults = (eventBus: EventBus, content: readonly unknown[]): void => {
  for (const block of content.filter(isRecord)) {
    if (stringField(block, 'type') !== 'tool_result') continue;
    const tool = stringField(block, 'name') ?? stringField(block, 'tool_use_id') ?? '';
    const status = block['is_error'] === true ? 'error' : 'ok';
    publishToolResultEvent(eventBus, PROVIDER_NAME, tool, status, previewToolResult(block['content']));
  }
};

/** `assistant` and `user` lines carry content; `system` / `result` feed other telemetry and are skipped. */
const publishStreamLineEvents = (eventBus: EventBus, line: ClaudeStreamLine): void => {
  const type = stringField(line.json, 'type');
  if (type !== 'assistant' && type !== 'user') return;
  const content = recordField(line.json, 'message')?.['content'];
  if (!Array.isArray(content)) return;
  if (type === 'assistant') publishAssistantLine(eventBus, content);
  else publishToolResults(eventBus, content);
};

/**
 * Read-only sessions use `bypassPermissions` plus a deny list, never `--permission-mode plan`: in
 * `-p` mode plan asks for approval on every tool, reads included, and no human is there to answer.
 * `acceptEdits` is no good for full-auto either — it still prompts for `Bash` and hangs on stdin.
 * Deny rules beat `bypassPermissions`. `Write` stays open under every profile so `signals.json` can
 * land; topology (cwd + `--add-dir`) scopes it.
 * Docs: https://code.claude.com/docs/en/agent-sdk/permissions
 */
const TOOL_EDIT = ['Edit', 'MultiEdit', 'NotebookEdit'] as const;
const TOOL_SHELL = ['Bash'] as const;
const TOOL_NETWORK = ['WebFetch', 'WebSearch'] as const;

const disallowedToolsFor = (p: SessionPermissions): readonly string[] => [
  ...(p.canModifyRepoFiles ? [] : TOOL_EDIT),
  ...(p.canRunShell ? [] : TOOL_SHELL),
  ...(p.canAccessNetwork ? [] : TOOL_NETWORK),
];

/** Build the argv for one Claude invocation; an unknown model is an `InvalidStateError`. */
export const buildClaudeArgs = (session: AiSession): Result<readonly string[], InvalidStateError> => {
  const validated = validateModel(session.model, isClaudeModel, {
    entity: PROVIDER_NAME,
    attemptedAction: 'build argv',
    notKnownMessage: `claude-provider: '${session.model}' is not a known Claude model`,
  });
  if (!validated.ok) return Result.error(validated.error);
  // Without `-p` claude opens its TUI and silently discards the piped prompt; stream-json requires `--verbose`.
  const args: string[] = [
    '-p',
    '--verbose',
    '--output-format',
    'stream-json',
    '--model',
    session.model,
    '--permission-mode',
    'bypassPermissions',
  ];
  const denied = disallowedToolsFor(session.permissions);
  if (denied.length > 0) args.push('--disallowedTools', denied.join(','));
  for (const root of resolveWritableRoots(session)) args.push('--add-dir', String(root));
  if (session.resume !== undefined) args.push('--resume', String(session.resume));
  // Forwarded verbatim; the CLI rejects unknown levels itself.
  if (session.effort !== undefined) args.push('--effort', session.effort);
  return Result.ok(args);
};

export const createClaudeProvider = (deps: HeadlessProviderDeps): HeadlessAiProvider =>
  createHeadlessProvider({
    providerSlug: 'claude',
    deps,
    resumeStaleRe: RESUME_STALE_RE,
    createGenerateContext: (base) => ({
      attempt: async (attemptSession) => {
        const built = buildClaudeArgs(attemptSession);
        if (!built.ok) return { kind: 'error', error: built.error };

        const parser = createClaudeStreamParser();
        const onLine = (line: ClaudeStreamLine): void => {
          parser.ingest(line);
          publishStreamLineEvents(deps.eventBus, line);
        };

        return runProviderAttempt({
          ...base,
          args: built.value,
          session: attemptSession,
          env: claudeHeadlessEnv(attemptSession),
          stdin: attemptSession.prompt,
          rateLimitRe: RATE_LIMIT_RE,
          onStdoutChunk: (chunk) => {
            parser.feed(chunk, onLine);
          },
          flush: () => {
            parser.flush(onLine);
          },
          getSessionId: () => parser.snapshot().sessionId,
          // Quota errors arrive in the stdout `result` body, not on stderr.
          getStdoutTail: () => parser.snapshot().body || undefined,
          getBody: () => Promise.resolve(Result.ok(parser.snapshot().body)),
          getUsage: () => {
            const { model, usage, liveUsage } = parser.snapshot();
            return { ...(model !== undefined ? { model } : {}), ...usage, ...liveUsage };
          },
        });
      },
    }),
  });
