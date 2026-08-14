import { Result } from '@src/domain/result.ts';
import type { HeadlessAiProvider } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import type { HeadlessProviderDeps } from '@src/integration/ai/providers/_engine/headless-provider-deps.ts';
import type { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { isOpencodeModelIdShape } from '@src/domain/value/settings-models/opencode.ts';
import { resolveWritableRoots } from '@src/integration/ai/providers/_engine/resolve-roots.ts';
import { validateModel } from '@src/integration/ai/providers/_engine/validate-model.ts';
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
 *   | roots outside cwd       | `--auto` (see the additionalRoots note below)    |
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
 * profiles because it promotes the tool classes an operator's `opencode.json` sets to `ask`,
 * which is a real difference for configured installs even though the default build allows
 * writes either way. Per OpenCode's permissions documentation it does NOT override a class the
 * operator set to `deny` — those stay enforced under `--auto`.
 *
 * A future refinement — not wired here — is OpenCode's config-level `permission` block, which
 * can deny tool classes properly. That would need a generated per-session config file, so it is
 * deliberately out of scope for the first adapter.
 *
 * ## additionalRoots
 *
 * `opencode run` has no `--add-dir` equivalent; `--dir` sets a single root, and every access
 * outside it is gated by the `external_directory` permission — without a lever, a write to an
 * absolute path outside `--dir` prints `permission requested: external_directory (…);
 * auto-rejecting` and the tool call fails (verified against v1.18.15). That matters because the
 * wired chains routinely put `outputDir` outside `cwd` (readiness / detect-* allocate it under
 * `<dataRoot>/runs/…`; implement under `<dataRoot>/sprints/…`), so the audit-[09] envelope would
 * never land. `--auto` is the only argv spelling that clears the gate, so
 * {@link buildOpencodeArgs} emits it whenever {@link resolveWritableRoots} is non-empty. That
 * over-grants relative to the `--add-dir` adapters, which mount exactly the declared roots — the
 * same posture already named for the coarse permission mapping above.
 *
 * The precise-scoping refinement is OpenCode's config-level `permission.external_directory` map
 * (`{"<root>/**": "allow"}`), which would grant per-root instead of wholesale. Like the
 * `permission` block above, it needs a generated per-session config file, so it is out of scope
 * for the first adapter.
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
  // Convention parity with the other adapter entrypoints, NOT a suspended-model fix:
  // `isSuspendedModel` keys on the BARE id and OpenCode ids are `provider/model`, so the
  // suspension arm never matches here either way — the shape gate is what earns the call.
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
  // Forward effort verbatim to `--variant`. Accepted values are set by the upstream provider
  // behind the model id, so the CLI is the arbiter — same posture as codex's effort handling.
  if (session.effort !== undefined) {
    args.push('--variant', session.effort);
  }
  // See the permission / additionalRoots notes in the module comment. `--auto` does not gate
  // writes inside `--dir` (they run either way) — it auto-approves the tool classes an
  // operator's opencode.json sets to `ask`, including the `external_directory` gate, which is
  // the only argv lever that lets the AI write an `outputDir` (or any additional root) outside
  // `cwd`. A class the operator set to `deny` stays denied.
  const needsExternalRoots = resolveWritableRoots(session).length > 0;
  if (session.permissions.autoApprove || needsExternalRoots) {
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
      return emitTokenUsage(deps.eventBus, attemptSession, sessionId_, {
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
