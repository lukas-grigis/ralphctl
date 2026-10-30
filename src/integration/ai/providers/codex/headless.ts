import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type { HeadlessAiProvider } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import { RATE_LIMIT_SCAN_TAIL_CAP, createBoundedTail } from '@src/integration/ai/providers/_engine/bounded-tail.ts';
import { isRecord, numberField, recordField, stringField } from '@src/integration/ai/providers/_engine/json-field.ts';
import { createCappedLineFeed, emitJsonObjectLine } from '@src/integration/ai/providers/_engine/line-feed.ts';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import type { CodexProviderDeps } from '@src/integration/ai/providers/_engine/headless-provider-deps.ts';
import { resolveWritableRoots } from '@src/integration/ai/providers/_engine/resolve-roots.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import type { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { isCodexModel } from '@src/domain/value/settings-models/codex.ts';
import { validateModel } from '@src/integration/ai/providers/_engine/validate-model.ts';
import { DEFAULT_RATE_LIMIT_RE } from '@src/integration/ai/providers/_engine/classify-spawn-exit.ts';
import {
  publishAssistantEvent,
  publishToolResultEvent,
  publishToolUseEvent,
  previewJson,
} from '@src/integration/ai/providers/_engine/stream-debug-events.ts';
import type { AttemptOutcome } from '@src/integration/ai/providers/_engine/attempt-outcome.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import {
  type AttemptBase,
  createHeadlessProvider,
  runProviderAttempt,
} from '@src/integration/ai/providers/_engine/run-provider-attempt.ts';
import { messageOf } from '@src/domain/value/error/error-message.ts';

/**
 * {@link HeadlessAiProvider} backed by the OpenAI Codex CLI (`codex` v0.130.0+). Permission and
 * resume-sandbox rationale lives in `.claude/docs/SECURITY.md`.
 *
 *   | AiSession field         | Codex argv                                                       |
 *   | ----------------------- | ---------------------------------------------------------------- |
 *   | fresh session           | `exec`                                                           |
 *   | resume: <SessionId>     | `exec resume <id>`                                               |
 *   | (always)                | `--skip-git-repo-check -o <tmpfile> --json`                      |
 *   | model                   | `-m <model>`                                                     |
 *   | cwd                     | `-C <cwd>` (fresh); resume runs in the spawn cwd                 |
 *   | additionalRoots         | `--add-dir <root>` (fresh)                                       |
 *   |                         | `-c sandbox_workspace_write.writable_roots=[…]` (resume)         |
 *   | permissions (any)       | `-s workspace-write` (fresh) / `-c sandbox_mode=…` (resume)      |
 *   | canAccessNetwork        | `-c sandbox_workspace_write.network_access=<bool>`               |
 *   |                         | `-c web_search="live"` (or `"disabled"` when false)              |
 *   | effort: <level>         | `-c model_reasoning_effort=<level>`                              |
 *   | role: evaluator         | `-c memories.{use,generate}_memories=false`                      |
 *   | prompt                  | piped to stdin, with a trailing `-`                              |
 *
 * The body is read back from the `-o` tempfile. The session id is `thread_id` on the leading
 * `thread.started` record and is what `exec resume <id>` accepts. `exec` has no `--search`, so
 * network access goes through `-c` on both paths. Debug events map `item.completed` records: agent_message
 * → assistant, command_execution / function_call → tool_use, function_call_output → tool_result.
 *
 * Docs: https://developers.openai.com/codex/cli/reference, https://developers.openai.com/codex/noninteractive
 */

const PROVIDER_NAME = 'codex-provider';

// `read-only` would block signals.json too, so every profile runs `workspace-write`; topology is the envelope.
const CODEX_SANDBOX = 'workspace-write';

interface BuildCodexArgsOpts {
  readonly outputFile: string;
}

// JSON string escapes are valid TOML basic-string escapes, so this is a TOML array literal.
const tomlStringArray = (values: readonly AbsolutePath[]): string =>
  `[${values.map((v) => JSON.stringify(String(v))).join(',')}]`;

/** Build the argv for one Codex invocation; an unknown model is an `InvalidStateError`. */
export const buildCodexArgs = (
  session: AiSession,
  opts: BuildCodexArgsOpts
): Result<readonly string[], InvalidStateError> => {
  const validated = validateModel(session.model, isCodexModel, {
    entity: PROVIDER_NAME,
    attemptedAction: 'build argv',
    notKnownMessage: `codex-provider: '${session.model}' is not a known Codex model`,
  });
  if (!validated.ok) return Result.error(validated.error);

  const args: string[] = ['exec'];
  const isResume = session.resume !== undefined;
  if (isResume) {
    args.push('resume', String(session.resume));
  }
  // No `--ephemeral`: it skips writing the rollout, so every later `exec resume` found nothing.
  args.push('--skip-git-repo-check', '-o', opts.outputFile, '--json', '-m', session.model);
  const roots = resolveWritableRoots(session);
  if (isResume) {
    // `exec resume` has no -C / -s / --add-dir and runs read-only unless the sandbox is re-declared.
    args.push('-c', `sandbox_mode="${CODEX_SANDBOX}"`);
    if (roots.length > 0) args.push('-c', `sandbox_workspace_write.writable_roots=${tomlStringArray(roots)}`);
  } else {
    args.push('-C', String(session.cwd), '-s', CODEX_SANDBOX);
    for (const root of roots) {
      args.push('--add-dir', String(root));
    }
  }
  // `network_access` defaults to false under workspace-write, which also blocks installs and fetches in shell commands.
  const network = session.permissions.canAccessNetwork;
  args.push(
    '-c',
    `sandbox_workspace_write.network_access=${String(network)}`,
    '-c',
    `web_search="${network ? 'live' : 'disabled'}"`
  );
  // Forwarded verbatim; codex rejects unknown or model-incompatible levels itself.
  if (session.effort !== undefined) {
    args.push('-c', `model_reasoning_effort=${session.effort}`);
  }
  // Memories carry over from earlier sessions; the evaluator side stays a fresh-context judge.
  if (session.role === 'evaluator') {
    args.push('-c', 'memories.use_memories=false', '-c', 'memories.generate_memories=false');
  }
  // Without the trailing `-`, codex treats stdin as side context and hangs waiting for a prompt arg.
  args.push('-');
  return Result.ok(args);
};

/**
 * A lost rollout fails `exec resume` with "thread/resume failed: no rollout found … (code -32600)".
 * `code -32600` is a deliberately broad backstop: a spurious match costs one cold respawn, never
 * correctness.
 */
const RESUME_STALE_RE = /no rollout found|thread\/resume failed|code -32600/i;

let tempCounter = 0;
const defaultMkTempPath = (): string => {
  tempCounter += 1;
  return join(tmpdir(), `ralphctl-codex-${String(process.pid)}-${String(Date.now())}-${String(tempCounter)}.txt`);
};

/**
 * The CLI's own fatal error from a `{"type":"error"}` / `{"type":"turn.failed"}` record — codex
 * reports API rejections (e.g. an effort level the model doesn't support) there, not on stderr.
 * The `message` is often a JSON-encoded API error body; its inner `error.message` (+ `param`) is
 * unwrapped so the operator reads one line instead of a pretty-printed envelope.
 */
const codexStreamErrorText = (obj: Record<string, unknown>): string | undefined => {
  const type = stringField(obj, 'type');
  const raw =
    type === 'error'
      ? stringField(obj, 'message')
      : type === 'turn.failed'
        ? stringField(recordField(obj, 'error'), 'message')
        : undefined;
  if (raw === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    const inner = isRecord(parsed) ? recordField(parsed, 'error') : undefined;
    const message = stringField(inner, 'message');
    if (message === undefined) return raw;
    const param = stringField(inner, 'param');
    return param !== undefined ? `${message} (param: ${param})` : message;
  } catch {
    return raw;
  }
};

/** Debug events for one `item.completed` record; every other record type has no payload to surface. */
const publishCodexStreamLineEvents = (eventBus: EventBus, obj: Record<string, unknown>): void => {
  if (stringField(obj, 'type') !== 'item.completed') return;
  const item = recordField(obj, 'item');
  switch (stringField(item, 'type')) {
    case 'agent_message':
      publishAssistantEvent(eventBus, PROVIDER_NAME, stringField(item, 'text'));
      break;
    case 'command_execution':
      publishToolUseEvent(eventBus, PROVIDER_NAME, 'command_execution', stringField(item, 'command'));
      break;
    case 'function_call': {
      const rawArgs = item?.['arguments'];
      const argsPreview = typeof rawArgs === 'string' ? rawArgs : previewJson(rawArgs);
      publishToolUseEvent(eventBus, PROVIDER_NAME, stringField(item, 'name') ?? '', argsPreview);
      break;
    }
    case 'function_call_output': {
      const tool = stringField(item, 'name') ?? stringField(item, 'call_id') ?? '';
      const status = item?.['is_error'] === true || stringField(item, 'status') === 'error' ? 'error' : 'ok';
      publishToolResultEvent(eventBus, PROVIDER_NAME, tool, status, stringField(item, 'output'));
      break;
    }
  }
};

/** Assistant text of an `agent_message` item — codex reports a quota throttle there, not always on stderr. */
const agentMessageText = (obj: Record<string, unknown>): string | undefined => {
  if (stringField(obj, 'type') !== 'item.completed') return undefined;
  const item = recordField(obj, 'item');
  return stringField(item, 'type') === 'agent_message' ? stringField(item, 'text') : undefined;
};

/** Per-attempt accumulator over codex's JSONL stdout. One fresh instance per `attempt()`. */
const createCodexAttemptTracker = (eventBus: EventBus) => {
  let sessionId: string | undefined;
  let model: string | undefined;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  const agentMessageTail = createBoundedTail(RATE_LIMIT_SCAN_TAIL_CAP);
  let streamError: string | undefined;
  const lineFeed = createCappedLineFeed<Record<string, unknown>>('codex-stream', emitJsonObjectLine);

  const dispatch = (obj: Record<string, unknown>): void => {
    publishCodexStreamLineEvents(eventBus, obj);
    streamError = codexStreamErrorText(obj) ?? streamError;
    const text = agentMessageText(obj);
    if (text !== undefined) agentMessageTail.append(agentMessageTail.value().length > 0 ? `\n${text}` : text);

    // 0.130.x sends `thread_id` on `thread.started`; `session_id` / `sessionId` cover other builds.
    sessionId ??= stringField(obj, 'thread_id', 'session_id', 'sessionId');
    model ??= stringField(obj, 'model');
    // Last write wins: `turn.completed` carries the cumulative figure.
    const source = recordField(obj, 'usage') ?? obj;
    inputTokens = numberField(source, 'input_tokens', 'inputTokens', 'prompt_tokens') ?? inputTokens;
    outputTokens = numberField(source, 'output_tokens', 'outputTokens', 'completion_tokens') ?? outputTokens;
  };

  return {
    consumeChunk: (chunk: string) => {
      lineFeed.feed(chunk, dispatch);
    },
    flush: () => {
      lineFeed.flush(dispatch);
    },
    getSessionId: () => sessionId,
    getUsage: () => ({
      ...(model !== undefined ? { model } : {}),
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
    }),
    getStdoutTail: () => agentMessageTail.value() || undefined,
    getStreamError: () => streamError,
  };
};

/**
 * One codex spawn. `outputFile` is minted fresh per attempt, so a killed later attempt never reads
 * back the prior attempt's body.
 */
const runCodexAttempt = (
  attemptSession: AiSession,
  outputFile: string,
  base: AttemptBase,
  readFile: (path: string) => Promise<string>
): Promise<AttemptOutcome> => {
  const built = buildCodexArgs(attemptSession, { outputFile });
  if (!built.ok) return Promise.resolve({ kind: 'error', error: built.error });

  const tracker = createCodexAttemptTracker(base.eventBus);

  return runProviderAttempt({
    ...base,
    args: built.value,
    session: attemptSession,
    stdin: attemptSession.prompt,
    rateLimitRe: DEFAULT_RATE_LIMIT_RE,
    onStdoutChunk: tracker.consumeChunk,
    flush: tracker.flush,
    getSessionId: tracker.getSessionId,
    getStdoutTail: tracker.getStdoutTail,
    getProcessErrorText: tracker.getStreamError,
    // The tempfile may be missing or partial after a SIGTERM; `onSuccess` also runs on signals-recovery,
    // so an unreadable body is logged and mirrored as empty rather than failing the attempt.
    getBody: async () => {
      try {
        return Result.ok(await readFile(outputFile));
      } catch (err) {
        if (err instanceof AbortError) throw err;
        base.eventBus.publish({
          type: 'log',
          level: 'debug',
          message: 'codex-provider: forensic body tempfile unreadable',
          meta: { error: messageOf(err) },
          at: IsoTimestamp.now(),
        });
        return Result.ok('');
      }
    },
    getUsage: tracker.getUsage,
  });
};

export const createCodexProvider = (deps: CodexProviderDeps): HeadlessAiProvider => {
  const readFile = deps.readFile ?? ((path) => fs.readFile(path, 'utf8'));
  // Best-effort: orphan tempfiles are bounded by os.tmpdir() rotation.
  const unlink = deps.unlink ?? ((path: string) => fs.unlink(path).catch(() => undefined));
  const mkTempPath = deps.mkTempPath ?? defaultMkTempPath;

  return createHeadlessProvider({
    providerSlug: 'codex',
    deps,
    resumeStaleRe: RESUME_STALE_RE,
    createGenerateContext: (base) => {
      // A fresh tempfile per attempt (see runCodexAttempt); every minted path is unlinked on cleanup.
      const outputFiles: string[] = [];
      return {
        attempt: (attemptSession) => {
          const outputFile = mkTempPath();
          outputFiles.push(outputFile);
          return runCodexAttempt(attemptSession, outputFile, base, readFile);
        },
        cleanup: async () => {
          for (const outputFile of outputFiles) await unlink(outputFile);
        },
      };
    },
  });
};
