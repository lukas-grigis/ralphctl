import { dirname, join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { buildPromptPointer } from '@src/integration/ai/providers/_engine/prompt-pointer.ts';
import { writeTextAtomic } from '@src/integration/io/fs.ts';
import type { HeadlessAiProvider } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import {
  FORENSIC_BODY_TAIL_CAP,
  RATE_LIMIT_SCAN_TAIL_CAP,
  createBoundedTail,
} from '@src/integration/ai/providers/_engine/bounded-tail.ts';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import type { HeadlessProviderDeps } from '@src/integration/ai/providers/_engine/headless-provider-deps.ts';
import { appendRoot, resolveWritableRoots } from '@src/integration/ai/providers/_engine/resolve-roots.ts';
import type { SessionPermissions } from '@src/integration/ai/providers/_engine/session-permissions.ts';
import type { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { isCopilotModel } from '@src/domain/value/settings-models/copilot.ts';
import { validateModel } from '@src/integration/ai/providers/_engine/validate-model.ts';
import { createCopilotStreamParser } from '@src/integration/ai/providers/copilot/parse-stream.ts';
import type { CopilotStreamLine, CopilotUsage } from '@src/integration/ai/providers/_engine/copilot-stream.ts';
import { DEFAULT_RATE_LIMIT_RE } from '@src/integration/ai/providers/_engine/classify-spawn-exit.ts';
import { publishAssistantEvent } from '@src/integration/ai/providers/_engine/stream-debug-events.ts';
import { truncateField } from '@src/integration/ai/providers/_engine/truncate-debug-field.ts';
import {
  type AttemptBase,
  createHeadlessProvider,
  runProviderAttempt,
} from '@src/integration/ai/providers/_engine/run-provider-attempt.ts';
import type { AttemptOutcome } from '@src/integration/ai/providers/_engine/attempt-outcome.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';

/**
 * {@link HeadlessAiProvider} backed by the GitHub Copilot CLI (`copilot`, v1.0.12+). Permission
 * rationale lives in `.claude/docs/SECURITY.md`.
 *
 *   | AiSession field                | Copilot flag                                       |
 *   | ------------------------------ | -------------------------------------------------- |
 *   | (always)                       | `--output-format=json --silent --no-ask-user`      |
 *   | model                          | `--model=<model>`                                  |
 *   | additionalRoots + prompt dir   | `--add-dir=<root>` per root                        |
 *   | permissions full-auto          | `--allow-all`                                      |
 *   | permissions otherwise          | `--allow-all-tools --deny-tool=shell`              |
 *   | resume: <id>                   | `--resume=<id>`                                    |
 *   | effort: <level>                | `--effort=<level>`                                 |
 *   | prompt                         | file + argv: `-p <pointer at that file>`           |
 *
 * Copilot has no stdin prompt path and `--prompt-file` is unimplemented upstream (copilot-cli#3398),
 * so the prompt is written next to `signals.json` and `-p` carries a pointer at it — the body
 * itself blew the 32,767-byte Windows command line. There is no inline fallback.
 *
 * As of 1.0.51 the JSON stream has no recognisable tool_use / tool_result records (tool calls are
 * flattened into `assistant.message` text), so only `assistant` debug events are published.
 *
 * Docs: https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference
 */

// The CLI's wording for an unknown resume id is undocumented, so this stays conservative.
const RESUME_STALE_RE = /(session|conversation)[^\n]*not found|no (session|conversation) found/i;

const isFullAuto = (p: SessionPermissions): boolean => p.autoApprove && p.canModifyRepoFiles && p.canRunShell;

const PROVIDER_NAME = 'copilot-provider';

/**
 * Distinct from the flow-written `prompt.md` beside it: that one records what the round was asked,
 * this one what THIS spawn was handed (a corrective re-invocation overwrites it).
 */
const COPILOT_PROMPT_FILENAME = 'copilot-prompt.md';

/** Build the argv for one Copilot invocation; an unknown model is an `InvalidStateError`. */
export const buildCopilotArgs = (
  session: AiSession,
  promptFile: string
): Result<readonly string[], InvalidStateError> => {
  const validated = validateModel(session.model, isCopilotModel, {
    entity: PROVIDER_NAME,
    attemptedAction: 'build argv',
    notKnownMessage: `copilot-provider: '${session.model}' is not a known Copilot model`,
  });
  if (!validated.ok) return Result.error(validated.error);
  // Without `--autopilot` Copilot may pause between actions and never finish the turn.
  // `--max-autopilot-continues=200` is a runaway cap: 1.0.91 defaulted to 5, which cut an implement
  // generator off before `task-complete`, and the current default (unlimited) never stops a loop.
  const args: string[] = [
    '--output-format=json',
    '--autopilot',
    '--max-autopilot-continues=200',
    '--silent',
    '--no-ask-user',
    `--model=${session.model}`,
  ];
  if (session.resume !== undefined) {
    args.push(`--resume=${String(session.resume)}`);
  }
  // Forwarded verbatim; the CLI rejects unknown levels itself.
  if (session.effort !== undefined) {
    args.push(`--effort=${session.effort}`);
  }
  if (isFullAuto(session.permissions)) {
    args.push('--allow-all');
  } else {
    // Write stays open for signals.json. Without the explicit allow, every non-denied tool would
    // hit a confirmation prompt that `--no-ask-user` turns into a refusal.
    args.push('--allow-all-tools', '--deny-tool=shell');
  }
  // Auto-mount `outputDir` so signals.json can land via the write tool (see resolve-roots.ts), and
  // the prompt file's directory, or the pointer would name a path the read tool may not open. The
  // two are usually the same directory, which `appendRoot` folds out.
  const promptDir = AbsolutePath.parse(dirname(promptFile));
  const roots = appendRoot(
    resolveWritableRoots(session),
    promptDir.ok ? promptDir.value : undefined,
    String(session.cwd)
  );
  for (const root of roots) {
    args.push(`--add-dir=${String(root)}`);
  }
  args.push('-p', buildPromptPointer(promptFile));
  return Result.ok(args);
};

/** Raw stdout line as a debug event, truncated like every stream-originated field so log entries stay capped. */
const publishStdoutJsonLine = (eventBus: EventBus, line: CopilotStreamLine): void => {
  const rawLine = truncateField(line.raw);
  eventBus.publish({
    type: 'log',
    level: 'debug',
    message: 'copilot-provider: stdout json line',
    ...(rawLine !== undefined ? { meta: { raw: rawLine } } : {}),
    at: IsoTimestamp.now(),
  });
};

const runCopilotAttempt = async (attemptSession: AiSession, base: AttemptBase): Promise<AttemptOutcome> => {
  // Next to signals.json, inside a mounted root for every caller. Argv is built (and the model
  // validated) before the write, so a spawn that never happens leaves no stray file.
  const promptFile = join(dirname(String(attemptSession.signalsFile)), COPILOT_PROMPT_FILENAME);
  const built = buildCopilotArgs(attemptSession, promptFile);
  if (!built.ok) return { kind: 'error', error: built.error };
  const wrote = await writeTextAtomic(promptFile, attemptSession.prompt);
  if (!wrote.ok) return { kind: 'error', error: wrote.error };

  const parser = createCopilotStreamParser();
  // Backs body.txt; its last bytes are also the rate-limit haystack (quota shows up in result text).
  const forensicTail = createBoundedTail(FORENSIC_BODY_TAIL_CAP);
  const record = (text: string): void => forensicTail.append(`${text}\n`);
  let sessionId: string | undefined;
  let model: string | undefined;
  let usage: CopilotUsage = {};

  const onLine = (line: CopilotStreamLine): void => {
    // Non-JSON banner / status lines go to body.txt only.
    if (line.json === undefined) {
      record(line.raw);
      return;
    }
    sessionId ??= line.sessionId;
    model ??= line.model;
    // Last write wins: later meta lines carry the more current cumulative count.
    if (line.usage !== undefined) usage = line.usage;
    if (line.bodyText !== undefined && line.bodyText.length > 0) {
      record(line.bodyText);
      publishAssistantEvent(base.eventBus, PROVIDER_NAME, line.bodyText);
    } else if (line.sessionId === undefined && line.model === undefined && line.usage === undefined) {
      // Unrecognised record: keep its raw form for body.txt. Never parse it for signals — Copilot
      // echoes the prompt as `user.message`, which carries literal harness tags.
      record(line.raw);
    }
    publishStdoutJsonLine(base.eventBus, line);
  };

  return runProviderAttempt({
    ...base,
    args: built.value,
    session: attemptSession,
    rateLimitRe: DEFAULT_RATE_LIMIT_RE,
    onStdoutChunk: (chunk) => {
      parser.feed(chunk, onLine);
    },
    flush: () => {
      parser.flush(onLine);
    },
    getSessionId: () => sessionId,
    getStdoutTail: () => forensicTail.value().slice(-RATE_LIMIT_SCAN_TAIL_CAP) || undefined,
    getBody: () => Promise.resolve(Result.ok(forensicTail.value())),
    getUsage: () => ({ ...(model !== undefined ? { model } : {}), ...usage }),
  });
};

export const createCopilotProvider = (deps: HeadlessProviderDeps): HeadlessAiProvider =>
  createHeadlessProvider({
    providerSlug: 'copilot',
    deps,
    resumeStaleRe: RESUME_STALE_RE,
    createGenerateContext: (base) => ({ attempt: (attemptSession) => runCopilotAttempt(attemptSession, base) }),
  });
