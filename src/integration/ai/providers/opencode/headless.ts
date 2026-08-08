import { Result } from '@src/domain/result.ts';
import type { HeadlessAiProvider } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import type { HeadlessProviderDeps } from '@src/integration/ai/providers/_engine/headless-provider-deps.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { isOpencodeModelIdShape } from '@src/domain/value/settings-models/opencode.ts';
import { type ProviderSpawn, defaultProviderSpawn } from '@src/integration/ai/providers/_engine/spawn.ts';
import { DEFAULT_RATE_LIMIT_RE } from '@src/integration/ai/providers/_engine/classify-spawn-exit.ts';
import type { AttemptOutcome } from '@src/integration/ai/providers/_engine/attempt-outcome.ts';
import {
  createHeadlessProvider,
  emitTokenUsage,
  runProviderAttempt,
} from '@src/integration/ai/providers/_engine/run-provider-attempt.ts';
import { createOpencodeAttemptTracker } from '@src/integration/ai/providers/opencode/parse-stream.ts';

/**
 * {@link HeadlessAiProvider} backed by the OpenCode CLI (`opencode` v1.18.x).
 *
 * Translation table (intent → OpenCode argv):
 *
 *   | AiSession field         | OpenCode argv                                    |
 *   | ----------------------- | ------------------------------------------------ |
 *   | (always)                | `run --format json`                              |
 *   | cwd                     | `--dir <cwd>`                                    |
 *   | model                   | `-m <provider/model>`                            |
 *   | resume: <SessionId>     | `-s <id>`                                        |
 *   | effort: <level>         | `--variant <level>`                              |
 *   | permissions.autoApprove | `--auto` (see the permission note below)         |
 *   | prompt                  | piped to stdin                                   |
 *
 * ## Prompt delivery
 *
 * `run` takes the message as a positional arg but also reads it from stdin when no positional
 * is given — verified against v1.18.15. Stdin is used here for the same reason the claude and
 * codex adapters do: harness prompts routinely exceed a comfortable argv budget, and `ARG_MAX`
 * failures would surface as opaque spawn errors. Unlike codex, OpenCode needs no `-` sentinel.
 *
 * ## Output handling — audit-[09] contract
 *
 * OpenCode has no `-o <tempfile>` equivalent; the assistant body exists only on the JSONL
 * stream. The tracker accumulates `text` records and serves them as the forensic body. As with
 * every adapter, the AI writes `signals.json` itself via its Write tool into
 * `session.outputDir` and the harness validates it post-spawn — the provider never touches it.
 *
 * ## Session id / resume
 *
 * `sessionID` rides on every stream record (no init frame to miss), and the captured
 * `ses_…` id is exactly what `-s` accepts, so it round-trips through `session.resume` across
 * gen-eval rounds. Verified end-to-end against the live CLI.
 *
 * ## Permissions — coarser than {@link SessionPermissions}, by CLI design
 *
 * `run` exposes exactly one approval control, `--auto`. Critically, omitting it does NOT make
 * the session read-only: a plain `opencode run` still executes write and edit tools without
 * prompting (verified — a no-`--auto` run created a file). There is therefore NO argv spelling
 * of `canModifyRepoFiles: false`.
 *
 * This is the same shape as the codex `sandboxFor` situation and takes the same answer: path
 * topology (`--dir` plus `outputDir`) is the real safety envelope, not the approval flag. The
 * over-grant is named here rather than hidden. `--auto` is still forwarded for `autoApprove`
 * profiles because it additionally clears permissions the operator's `opencode.json` gates
 * explicitly, which is a real difference for configured installs even though the default build
 * allows writes either way.
 *
 * A future refinement — not wired here — is OpenCode's config-level `permission` block, which
 * can deny tool classes properly. That would need a generated per-session config file, so it is
 * deliberately out of scope for the first adapter.
 *
 * ## additionalRoots
 *
 * OpenCode has no `--add-dir` equivalent; `--dir` sets a single root. Sessions whose
 * `additionalRoots` fall outside `cwd` are therefore not reachable by the AI. The adapter does
 * not silently pretend otherwise — {@link buildOpencodeArgs} surfaces nothing, but the writable
 * roots are left unmounted and `outputDir` must live under `cwd` for the signals envelope to
 * land, which is how every wired chain already arranges it.
 *
 * ## Model validation
 *
 * OpenCode is an aggregator: reachable ids depend on which upstream providers the operator has
 * authenticated, so validating against the shipped catalog would reject every authenticated
 * model. Only the `provider/model` SHAPE is checked — a bare `gpt-5.5` pasted from another
 * backend's catalog is a common mistake that otherwise produces an opaque CLI error. Beyond
 * that the CLI arbitrates, matching the codex adapter's policy for effort levels.
 *
 * Docs: https://opencode.ai/docs/cli/
 */

const PROVIDER_NAME = 'opencode-provider';

/**
 * Stale-resume detection. A `-s <id>` naming a session that no longer exists fails fast with
 * `Error: Session not found` and a non-zero exit (verified against v1.18.15). The gen-eval loop
 * threads the prior round's id as `session.resume`, so without this the task would block on a
 * turn that never ran; matching it lets the shared retry path fall back to a cold spawn.
 *
 * Kept slightly broader than the exact banner so a reworded future build still self-heals. A
 * spurious match costs one benign cold respawn — prompts are self-contained, so the only loss
 * is in-thread conversation memory, never correctness.
 */
const RESUME_STALE_RE = /session not found|no such session|unknown session/i;

/**
 * Build the argv for one OpenCode invocation. Validates the `provider/model` id shape; every
 * other narrowing is left to the CLI (see the module comment).
 */
export const buildOpencodeArgs = (session: AiSession): Result<readonly string[], InvalidStateError> => {
  if (!isOpencodeModelIdShape(session.model)) {
    return Result.error(
      new InvalidStateError({
        entity: PROVIDER_NAME,
        currentState: 'model-validation',
        attemptedAction: 'build argv',
        message: `opencode-provider: '${session.model}' is not a 'provider/model' id — OpenCode model ids are namespaced as '<provider>/<model>' (e.g. 'opencode/big-pickle') — run 'opencode models' to list yours`,
      })
    );
  }

  const args: string[] = ['run', '--format', 'json', '--dir', String(session.cwd), '-m', session.model];
  if (session.resume !== undefined) {
    args.push('-s', String(session.resume));
  }
  // Forward effort verbatim to `--variant`. Accepted values are set by the upstream provider
  // behind the model id, so the CLI is the arbiter — same posture as codex's effort handling.
  if (session.effort !== undefined) {
    args.push('--variant', session.effort);
  }
  // See the permission note in the module comment: this does not gate writes (they run either
  // way), it clears tool classes an operator's opencode.json denies explicitly.
  if (session.permissions.autoApprove) {
    args.push('--auto');
  }
  return Result.ok(args);
};

interface RunOpencodeAttemptOpts {
  readonly spawnFn: ProviderSpawn;
  readonly command: string;
  readonly deps: HeadlessProviderDeps;
}

/** Run one OpenCode spawn attempt with a fresh tracker wired into the stdout hooks. */
const runOpencodeAttempt = (
  attemptSession: AiSession,
  { spawnFn, command, deps }: RunOpencodeAttemptOpts
): Promise<AttemptOutcome> => {
  const built = buildOpencodeArgs(attemptSession);
  if (!built.ok) return Promise.resolve({ kind: 'error', error: built.error });

  const tracker = createOpencodeAttemptTracker(deps.eventBus);

  return runProviderAttempt({
    spawnFn,
    command,
    args: built.value,
    session: attemptSession,
    resolveOn: 'exit',
    stdin: attemptSession.prompt,
    rateLimitRe: DEFAULT_RATE_LIMIT_RE,
    onStdoutChunk: (chunk) => tracker.consumeChunk(chunk),
    flush: () => tracker.flush(),
    getSessionId: () => tracker.getSessionId(),
    getStdoutTail: () => tracker.getStdoutTail(),
    // The body comes off the stream rather than a tempfile, so it is always readable and never
    // needs the codex adapter's best-effort disk guard.
    getBody: () => Promise.resolve(Result.ok(tracker.getBody())),
    emitProviderTokenUsage: (sessionId_) => {
      const inputTokens = tracker.getInputTokens();
      const outputTokens = tracker.getOutputTokens();
      emitTokenUsage(deps.eventBus, attemptSession, sessionId_, {
        provider: 'opencode',
        model: attemptSession.model,
        ...(inputTokens !== undefined ? { inputTokens } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {}),
      });
    },
    providerName: PROVIDER_NAME,
    providerSlug: 'opencode',
    eventBus: deps.eventBus,
    ...(deps.idleMs !== undefined ? { idleMs: deps.idleMs } : {}),
  });
};

export const createOpencodeProvider = (deps: HeadlessProviderDeps): HeadlessAiProvider => {
  const spawnFn: ProviderSpawn = deps.spawn ?? defaultProviderSpawn;
  const command = deps.command ?? 'opencode';

  return createHeadlessProvider({
    providerSlug: 'opencode',
    providerName: PROVIDER_NAME,
    resumeStaleRe: RESUME_STALE_RE,
    rateLimitRetries: deps.rateLimitRetries,
    eventBus: deps.eventBus,
    ...(deps.backoffSchedule !== undefined ? { backoffSchedule: deps.backoffSchedule } : {}),
    createGenerateContext: () => ({
      attempt: (attemptSession) => runOpencodeAttempt(attemptSession, { spawnFn, command, deps }),
    }),
  });
};
