import { dirname, join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import { isGrokModel } from '@src/domain/value/settings-models/grok.ts';
import { writeTextAtomic } from '@src/integration/io/fs.ts';
import type { HeadlessAiProvider } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import type { HeadlessProviderDeps } from '@src/integration/ai/providers/_engine/headless-provider-deps.ts';
import type { SessionPermissions } from '@src/integration/ai/providers/_engine/session-permissions.ts';
import { validateModel } from '@src/integration/ai/providers/_engine/validate-model.ts';
import { type ProviderSpawn, defaultProviderSpawn } from '@src/integration/ai/providers/_engine/spawn.ts';
import { DEFAULT_RATE_LIMIT_RE } from '@src/integration/ai/providers/_engine/classify-spawn-exit.ts';
import type { AttemptOutcome } from '@src/integration/ai/providers/_engine/attempt-outcome.ts';
import {
  createHeadlessProvider,
  emitTokenUsage,
  runProviderAttempt,
} from '@src/integration/ai/providers/_engine/run-provider-attempt.ts';
import { createGrokAttemptTracker } from '@src/integration/ai/providers/grok/parse-stream.ts';

/**
 * {@link HeadlessAiProvider} backed by the Grok Build CLI (`grok` 1.0.5).
 *
 * Translation table (intent → Grok argv):
 *
 *   | AiSession field                              | Grok argv                                              |
 *   | -------------------------------------------- | ------------------------------------------------------ |
 *   | (always)                                     | `--no-auto-update --output-format streaming-json`      |
 *   | cwd                                          | `--cwd <cwd>`                                          |
 *   | model                                        | `-m <model>`                                           |
 *   | resume: <SessionId>                          | `-r <id>`                                              |
 *   | effort: <level>                              | `--effort <level>`                                     |
 *   | permissions FULL_AUTO                        | `--always-approve`                                     |
 *   | permissions READ_ONLY                        | `--always-approve --disallowed-tools search_replace,run_terminal_command,run_terminal_cmd --no-subagents` |
 *   | prompt                                       | `--prompt-file <grok-prompt.md>`                         |
 *
 * `--prompt-file` is what triggers headless. Grok does not read piped stdin as the prompt, and
 * `-p` is not a fallback: that flag inlines the body (Windows ENAMETOOLONG) and is not the
 * headless switch. If the prompt file cannot be written, the spawn fails rather than hanging in
 * the TUI.
 *
 * The write tool is `write` and MUST stay allowed — audit-[09] lands `signals.json` through it.
 * Edit is `search_replace`; shell is dual-spelled (`run_terminal_command` is the live 1.0.5 id,
 * `run_terminal_cmd` is the docs' id). `--no-subagents` keeps a child agent from recovering
 * shell/edit under `--always-approve`. Never `--permission-mode plan` (blocks signals.json).
 * Never `--sandbox` — default-off is unrestricted FS, and a workspace sandbox would block `outputDir`.
 *
 * ## additionalRoots — named over-grant
 *
 * Grok has no `--add-dir`. With sandbox off, writes outside cwd work, so extra roots are treated
 * as a documented over-grant (same posture as OpenCode `--auto`) rather than an InvalidStateError.
 *
 * Docs: https://docs.x.ai/build/overview
 */

const PROVIDER_NAME = 'grok-provider';
const GROK_PROMPT_FILENAME = 'grok-prompt.md';

/**
 * Stale-resume detection. A `-r <id>` naming a session the CLI no longer has locally fails with
 * "Session "…" not found locally, restoring conversation from remote..." then
 * "Failed to restore session from remote: fetching session record: session get failed: 404".
 */
const RESUME_STALE_RE = /session(?: .+)? not found|failed to restore session|session get failed: 404/i;

const isFullAuto = (p: SessionPermissions): boolean => p.autoApprove && p.canModifyRepoFiles && p.canRunShell;

const materializeGrokPrompt = async (session: AiSession): Promise<Result<string, StorageError>> => {
  const path = join(dirname(String(session.signalsFile)), GROK_PROMPT_FILENAME);
  const wrote = await writeTextAtomic(path, session.prompt);
  if (!wrote.ok) return Result.error(wrote.error);
  return Result.ok(path);
};

export const buildGrokArgs = (session: AiSession, promptFile: string): Result<readonly string[], InvalidStateError> => {
  const validated = validateModel(session.model, isGrokModel, {
    entity: PROVIDER_NAME,
    attemptedAction: 'build argv',
    notKnownMessage: `grok-provider: '${session.model}' is not a known Grok model`,
  });
  if (!validated.ok) return Result.error(validated.error);

  const args: string[] = [
    '--no-auto-update',
    '--output-format',
    'streaming-json',
    '--prompt-file',
    promptFile,
    '--cwd',
    String(session.cwd),
    '-m',
    session.model,
  ];
  if (session.effort !== undefined) {
    args.push('--effort', session.effort);
  }
  if (session.resume !== undefined) {
    args.push('-r', String(session.resume));
  }
  args.push('--always-approve');
  if (!isFullAuto(session.permissions)) {
    // Write stays allowed so signals.json can land. search_replace (edit) plus both
    // shell ids (live `run_terminal_command` and the docs' `run_terminal_cmd`) are the
    // READ_ONLY denylist. `--no-subagents` blocks a child from recovering shell/edit.
    args.push('--disallowed-tools', 'search_replace,run_terminal_command,run_terminal_cmd');
    args.push('--no-subagents');
  }
  return Result.ok(args);
};

interface RunGrokAttemptOpts {
  readonly spawnFn: ProviderSpawn;
  readonly command: string;
  readonly deps: HeadlessProviderDeps;
}

const runGrokAttempt = async (
  attemptSession: AiSession,
  { spawnFn, command, deps }: RunGrokAttemptOpts
): Promise<AttemptOutcome> => {
  const promptFile = await materializeGrokPrompt(attemptSession);
  if (!promptFile.ok) return { kind: 'error', error: promptFile.error };
  const built = buildGrokArgs(attemptSession, promptFile.value);
  if (!built.ok) return { kind: 'error', error: built.error };

  const tracker = createGrokAttemptTracker(deps.eventBus);

  return runProviderAttempt({
    spawnFn,
    command,
    args: built.value,
    session: attemptSession,
    // `end` is last and is the only record that carries `sessionId`. Node can fire `exit`
    // before that chunk is delivered; `close` waits for the stdout pipe to drain.
    resolveOn: 'close',
    rateLimitRe: DEFAULT_RATE_LIMIT_RE,
    onStdoutChunk: (chunk) => tracker.consumeChunk(chunk),
    flush: () => tracker.flush(),
    getSessionId: () => tracker.getSessionId(),
    getStdoutTail: () => tracker.getStdoutTail(),
    getProcessErrorText: () => tracker.getStreamError(),
    getBody: () => Promise.resolve(Result.ok(tracker.getBody())),
    emitProviderTokenUsage: (sessionId_) => {
      const inputTokens = tracker.getInputTokens();
      const outputTokens = tracker.getOutputTokens();
      const cacheReadTokens = tracker.getCacheReadTokens();
      const cacheCreationTokens = tracker.getCacheCreationTokens();
      return emitTokenUsage(deps.eventBus, attemptSession, sessionId_, {
        provider: 'xai-grok',
        model: attemptSession.model,
        ...(inputTokens !== undefined ? { inputTokens } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {}),
        ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
        ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
      });
    },
    providerName: PROVIDER_NAME,
    providerSlug: 'grok',
    eventBus: deps.eventBus,
    ...(deps.idleMs !== undefined ? { idleMs: deps.idleMs } : {}),
  });
};

export const createGrokProvider = (deps: HeadlessProviderDeps): HeadlessAiProvider => {
  const spawnFn: ProviderSpawn = deps.spawn ?? defaultProviderSpawn;
  const command = deps.command ?? 'grok';

  return createHeadlessProvider({
    providerSlug: 'grok',
    providerName: PROVIDER_NAME,
    resumeStaleRe: RESUME_STALE_RE,
    rateLimitRetries: deps.rateLimitRetries,
    eventBus: deps.eventBus,
    ...(deps.backoffSchedule !== undefined ? { backoffSchedule: deps.backoffSchedule } : {}),
    createGenerateContext: () => ({
      attempt: (attemptSession) => runGrokAttempt(attemptSession, { spawnFn, command, deps }),
    }),
  });
};
