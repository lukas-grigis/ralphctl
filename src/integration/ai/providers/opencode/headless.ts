import { Result } from '@src/domain/result.ts';
import type { HeadlessAiProvider } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import type { HeadlessProviderDeps } from '@src/integration/ai/providers/_engine/headless-provider-deps.ts';
import type { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { isOpencodeModelIdShape } from '@src/domain/value/settings-models/opencode.ts';
import { resolveWritableRoots } from '@src/integration/ai/providers/_engine/resolve-roots.ts';
import { validateModel } from '@src/integration/ai/providers/_engine/validate-model.ts';
import { DEFAULT_RATE_LIMIT_RE } from '@src/integration/ai/providers/_engine/classify-spawn-exit.ts';
import type { AttemptOutcome } from '@src/integration/ai/providers/_engine/attempt-outcome.ts';
import {
  type AttemptBase,
  createHeadlessProvider,
  runProviderAttempt,
} from '@src/integration/ai/providers/_engine/run-provider-attempt.ts';
import { createOpencodeAttemptTracker } from '@src/integration/ai/providers/opencode/parse-stream.ts';

/**
 * {@link HeadlessAiProvider} backed by the OpenCode CLI (`opencode` v1.18.x). Why there is no
 * read-only spelling and why `--auto` rides on almost every run: `.claude/docs/SECURITY.md`.
 *
 *   | AiSession field         | OpenCode argv                                    |
 *   | ----------------------- | ------------------------------------------------ |
 *   | (always)                | `run --format json`                              |
 *   | cwd                     | `--dir <cwd>`                                    |
 *   | model                   | `-m <provider/model>`                            |
 *   | resume: <SessionId>     | `-s <id>`                                        |
 *   | effort: <level>         | `--variant <level>`                              |
 *   | permissions.autoApprove | `--auto`                                         |
 *   | roots outside cwd       | `--auto` (clears the `external_directory` gate)  |
 *   | prompt                  | piped to stdin (no `-` sentinel needed)          |
 *
 * The body exists only on the stream (no `-o` tempfile). `sessionID` rides on every record and is
 * exactly what `-s` accepts. Only the `provider/model` SHAPE is validated: reachable ids depend on
 * which upstreams the operator authenticated, so the shipped catalog would reject real models.
 *
 * Docs: https://opencode.ai/docs/cli/
 */

const PROVIDER_NAME = 'opencode-provider';

// `-s <id>` for a vanished session fails with `Error: Session not found`; kept slightly broader for rewordings.
const RESUME_STALE_RE = /session not found|no such session|unknown session/i;

/** Build the argv for one OpenCode invocation; only the `provider/model` id shape is validated. */
export const buildOpencodeArgs = (session: AiSession): Result<readonly string[], InvalidStateError> => {
  const validated = validateModel(session.model, isOpencodeModelIdShape, {
    entity: PROVIDER_NAME,
    attemptedAction: 'build argv',
    notKnownMessage: `opencode-provider: '${session.model}' is not a 'provider/model' id — OpenCode model ids are namespaced as '<provider>/<model>' (e.g. 'opencode/big-pickle') — run 'opencode models' to list yours`,
  });
  if (!validated.ok) return Result.error(validated.error);

  const args: string[] = ['run', '--format', 'json', '--dir', String(session.cwd), '-m', session.model];
  if (session.resume !== undefined) {
    args.push('-s', String(session.resume));
  }
  // Accepted variants depend on the upstream provider, so the CLI arbitrates.
  if (session.effort !== undefined) {
    args.push('--variant', session.effort);
  }
  // `--auto` is the only argv lever past the `external_directory` gate for an outputDir outside cwd.
  const needsExternalRoots = resolveWritableRoots(session).length > 0;
  if (session.permissions.autoApprove || needsExternalRoots) {
    args.push('--auto');
  }
  return Result.ok(args);
};

const runOpencodeAttempt = (attemptSession: AiSession, base: AttemptBase): Promise<AttemptOutcome> => {
  const built = buildOpencodeArgs(attemptSession);
  if (!built.ok) return Promise.resolve({ kind: 'error', error: built.error });

  const tracker = createOpencodeAttemptTracker(base.eventBus);

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
    // OpenCode reports fatal errors on stdout with an EMPTY stderr.
    getProcessErrorText: tracker.getStreamError,
    getBody: () => Promise.resolve(Result.ok(tracker.getBody())),
    getUsage: () => ({ model: attemptSession.model, ...tracker.getUsage() }),
  });
};

export const createOpencodeProvider = (deps: HeadlessProviderDeps): HeadlessAiProvider =>
  createHeadlessProvider({
    providerSlug: 'opencode',
    deps,
    resumeStaleRe: RESUME_STALE_RE,
    createGenerateContext: (base) => ({
      attempt: (attemptSession) => runOpencodeAttempt(attemptSession, base),
    }),
  });
