import { AbortError } from '@src/domain/value/error/abort-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { ProcessCrashError } from '@src/domain/value/error/process-crash-error.ts';
import { RateLimitError } from '@src/domain/value/error/rate-limit-error.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import { pathExists } from '@src/integration/io/fs.ts';
import { argvOverflowHint, errnoOf, isArgvOverflow } from '@src/integration/ai/providers/_engine/argv-budget.ts';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import type { AttemptOutcome } from '@src/integration/ai/providers/_engine/attempt-outcome.ts';

/**
 * Default rate-limit / quota detection pattern shared by the copilot + codex adapters. Broadened
 * past a bare `/rate.?limit/i` to also catch "quota" and a bare `429` — both CLIs surface a
 * throttle as "quota exceeded" / an HTTP 429 in their result text, neither of which contains the
 * literal "rate limit". The haystack is stderr PLUS the stdout body tail the adapter feeds via
 * `stdoutTail`. (claude keeps its own override — its wording differs: "usage limit reached", the
 * 5-hour window, `overloaded_error`.)
 */
export const DEFAULT_RATE_LIMIT_RE = /rate.?limit|quota|\b429\b/i;

/**
 * NARROW rate-limit pattern, applied to `stdoutTail` ONLY — never to stderr, which keeps the
 * adapter's own broad {@link DEFAULT_RATE_LIMIT_RE}-style pattern.
 *
 * Why two tiers: `stdoutTail` is ASSISTANT-GENERATED task output (claude's stream-json `result`
 * body, codex's `agent_message` tail, copilot's body tail, opencode's `text` records). The broad
 * pattern matches ordinary prose — "Implemented the rate limiter in src/throttle.ts", "retry logic
 * for HTTP 429 responses", "increased the disk quota" — so any non-zero exit on a task ABOUT
 * throttling (an idle-watchdog SIGTERM, say) was classified as a throttle, skipping the
 * signals.json recovery branch and sleeping through the whole backoff schedule before failing.
 *
 * This tier matches only the vendors' actual throttle sentences, so a false positive needs the
 * assistant to quote one verbatim. Bare `429`, bare `quota` and bare `rate limiter` are
 * deliberately absent. Real shapes still covered: claude's "usage limit reached" / 5-hour window /
 * `overloaded_error`, the API's `rate_limit_error`, and a JSON-quoted `"status": 429`.
 */
const STDOUT_RATE_LIMIT_RE =
  /usage limit reached|rate.?limit exceeded|rate_limit_error|overloaded_error|\b5-hour limit\b|"status"\s*:\s*429/i;

/**
 * Shared post-spawn classifier for the five headless AI provider adapters
 * (claude / codex / copilot / opencode / grok). Inspects the child's exit, the abort signal, stderr, and the
 * presence of `signals.json`, and decides whether the attempt is a success, a rate-limit
 * retry, an aborted operation, or a hard failure.
 *
 * Why centralise: the same decision tree was implicit (and partially wrong) in every adapter.
 * Two bugs surfaced that this helper fixes:
 *
 *  1. **Audit-[09] violation.** The contract says `signals.json` is authoritative — the AI
 *     writes it directly via its `Write` tool, the harness validates it post-spawn. The
 *     adapters were hard-failing on `signal === 'SIGTERM'` even when the AI had completed
 *     its work; an evaluator that wrote a passing verdict at +8 min and then hung until the
 *     idle-stdout watchdog SIGTERMed it at +13 min lost the passing verdict. The recovery
 *     branch here honours the contract: signals.json present ⇒ the work landed.
 *
 *  2. **CLAUDE.md §267 violation.** User-initiated cancel (Ctrl-C / TUI abort) was returning
 *     `InvalidStateError` ("process terminated via SIGTERM") instead of `AbortError`. Guards
 *     and fallbacks downstream catch the InvalidStateError shape and continue execution,
 *     violating "AbortError is the one error chains propagate transparently." Abort is
 *     classified first now so the right error type surfaces.
 *
 * **Exit code vs signal:** macOS Node surfaces an idle-watchdog SIGTERM as either
 * `{ code: null, signal: 'SIGTERM' }` OR `{ code: 143, signal: null }` depending on timing.
 * The recovery branch fires for both — it only looks at whether `signals.json` is on disk,
 * not at the exit shape.
 *
 * **Truncated / malformed signals.json is intentionally not validated here.** The adapter
 * only checks existence (via `pathExists`); the downstream validator in
 * `src/integration/ai/contract/_engine/validate-signals-file.ts` parses + schema-checks the
 * file and surfaces a `ParseError` when it's empty / truncated / malformed. Splitting it
 * this way keeps the adapter ignorant of the contract schema (which lives in its own
 * sibling-isolated directory) and lets the downstream validator's existing error path
 * handle the bad-content cases uniformly with the case where the AI just never wrote
 * signals.json at all.
 *
 * **Rate-limit on STDERR wins over recovery; on STDOUT it does not.** A throttle reported on
 * stderr surfaces `rate-limit` even if a partial `signals.json` from a previous attempt happens to
 * be on disk (per-round outputDir means it shouldn't be, but the precedence keeps the semantics
 * safe under reuse). A match found only in `stdoutTail` is weaker evidence — that haystack is
 * assistant prose — so a landed `signals.json` beats it: the envelope is proof the turn did its
 * work, and discarding it to sleep through the backoff schedule is the worse error.
 *
 * **Retryable crash vs. non-retryable config error.** Two failure branches surface a
 * `ProcessCrashError` (a TRANSIENT process death worth retrying within the attempt budget):
 * spawn-failed (the child never ran) and non-zero exit with no signals.json (the idle-stdout
 * watchdog SIGTERM shape). Both let the harness re-run the generator and only block once
 * `maxAttempts` is exhausted. Model-unavailable deliberately stays an `InvalidStateError`: a
 * model-availability failure is a CONFIG error, so retrying just burns the whole budget on the
 * same misconfiguration — it must keep blocking after one attempt.
 */
export type ProviderName =
  'claude-provider' | 'codex-provider' | 'copilot-provider' | 'opencode-provider' | 'grok-provider';

/**
 * Matches the provider-CLI "the selected model isn't available" failure across the backends that
 * report it on stderr. Real-world wordings observed:
 *  - copilot:  `Error: Model "gpt-5.4-nano" from --model flag is not available.`
 *  - codex:    `model not found`
 *  - claude:   `unknown model`
 *  - opencode: reports fatal CLI errors on a stdout `{"type":"error"}` record with EMPTY stderr,
 *    so the adapter feeds that record's text as {@link ClassifySpawnExitInput.processErrorText}
 *    and this regex scans it alongside stderr. Caveat: the wording observed for an unreachable
 *    `provider/model` id on v1.18.15 is `UnknownError: Unexpected server error. …`, which carries
 *    no `model` token and therefore still falls through to the retryable ProcessCrash branch —
 *    now at least WITH that text in the message instead of `<empty stderr>`. The durable fix for
 *    that case is a pre-flight check of the configured id against `opencode models`, not a looser
 *    regex: the same generic wording is also what a transient upstream outage produces, so
 *    treating it as a config error would convert a retryable blip into an immediate block.
 * Broad enough to catch phrasing drift (`model ... is not available`, `model not found`,
 * `unknown model`, `unsupported model`) yet anchored on the word `model` so it can't trip on
 * unrelated "not available" lines. Abort is classified first, so this regex never sees an
 * abort message even though it couldn't match one anyway.
 */
const MODEL_UNAVAILABLE_RE =
  /\bmodel\b[^\n]*\b(?:is\s+not\s+available|not\s+available|not\s+found)|\b(?:unknown|unsupported|invalid)\s+model\b/i;

export interface ClassifySpawnExitInput {
  readonly session: AiSession;
  readonly exit: {
    readonly code: number | null;
    readonly signal: string | null;
    /**
     * Set when the spawn raised an `'error'` event (binary missing / non-executable, or the
     * child died before stdin drained). Surfaces as an `InvalidStateError` before any exit-code
     * branch — a spawn error means the child never ran, so `code` / `signal` carry no signal.
     */
    readonly spawnError?: NodeJS.ErrnoException;
    /**
     * Size of the command line that was attempted, when the caller measured it. Lets the spawn-
     * error branch recognise an argv overflow whose errno is unhelpful — the same condition has
     * been seen surfacing as `ERROR_INVALID_PARAMETER` rather than `ENAMETOOLONG`.
     */
    readonly argvBytes?: number;
  };
  readonly stderr: string;
  /**
   * Matched against `stderr` ONLY to detect a 429 / quota throttle. Producer of the regex is the
   * adapter (per-provider wording differs), and it can be broad because stderr carries the CLI's
   * own diagnostics rather than model output. The stdout side uses the shared, narrow
   * {@link STDOUT_RATE_LIMIT_RE} instead — see `stdoutTail`.
   */
  readonly rateLimitRe: RegExp;
  /**
   * Provider-parsed stdout body tail, scanned with {@link STDOUT_RATE_LIMIT_RE} after `stderr`.
   * Lets a provider that surfaces quota messages in its stdout JSON envelope (claude stream-json
   * `result`, copilot/codex result records) still trip the overnight backoff. Optional — adapters
   * whose throttle wording always lands on stderr omit it.
   *
   * This is ASSISTANT-GENERATED text, so it is used for exactly one thing (the narrow rate-limit
   * tier) and never for the model-unavailable branch. Structured CLI error records belong in
   * `processErrorText`, not here.
   */
  readonly stdoutTail?: string;
  /**
   * The CLI's own STRUCTURED error record, parsed off stdout by adapters whose fatal errors never
   * reach stderr (opencode's `{"type":"error","error":{"name","data":{"message"}}}`). Used as the
   * stderr fallback in the failure message — otherwise the only explanation the CLI produced is
   * parsed and then dropped, leaving `process exited with code 1: <empty stderr>` — and scanned by
   * the model-unavailable branch, which is safe here precisely because this is a CLI error record
   * rather than model output.
   */
  readonly processErrorText?: string;
  /** Provider's best-effort captured session id, attached to `RateLimitError` when present. */
  readonly capturedSessionId?: string;
  readonly providerName: ProviderName;
  readonly eventBus: EventBus;
  /**
   * The banner id the adapter's `onIdle` callback used when publishing the watchdog
   * "killed stuck process" banner. The recovery branch publishes a `banner-clear` against
   * this exact id so the operator doesn't see a stuck-process warning beside a successful
   * outcome.
   */
  readonly watchdogBannerId: string;
  /**
   * `true` when the idle-stdout watchdog fired for this attempt (its `onIdle` callback ran, so
   * the SIGTERM the child died from was OURS). Threaded from the shared spawn scaffold because
   * a watchdog kill and an external SIGTERM are indistinguishable from the exit shape alone.
   * Rides onto the `ProcessCrashError` so the attempt record can say `watchdog-killed` rather
   * than the generic `process-crash`.
   */
  readonly watchdogKilled?: boolean;
  /**
   * Per-provider success block — emits token-usage, persists session-id.txt, mirrors
   * bodyFile, and returns `{ kind: 'success', output: ProviderOutput }`. Invoked on
   * `code === 0` AND on the recovery branch. When recovery fired, the helper splices
   * `recoveredFromExit` into the returned `output` so the caller can tell the two apart.
   */
  readonly onSuccess: () => AttemptOutcome | Promise<AttemptOutcome>;
}

/**
 * Shared `code=N (signal=S): <stderr tail>` prefix used by both non-zero-exit failure shapes.
 * Falls back to the provider-parsed `processErrorText` when the CLI wrote nothing to stderr —
 * opencode puts its whole explanation on a stdout error record, so without the fallback the
 * operator sees `<empty stderr>` and nothing else.
 */
const exitSummary = ({ exit, stderr, processErrorText }: ClassifySpawnExitInput): string => {
  const detail = stderr.trim() || processErrorText?.trim() || '<empty stderr>';
  return `process exited with code ${String(exit.code)}${exit.signal !== null ? ` (signal=${exit.signal})` : ''}: ${detail}`;
};

/**
 * The two branches that are decided BEFORE the exit code is even looked at. Returns `undefined`
 * when neither applies and the ladder should continue. Pure and synchronous.
 *
 *  - **Abort.** A user cancel that races a clean exit still surfaces as `AbortError` so the
 *    chain runner can propagate it transparently per the AbortError rule.
 *  - **Spawn error.** The child never ran — a missing / non-executable binary (ENOENT / EACCES)
 *    or a death before stdin drained. Without this the unhandled `'error'` event would have
 *    killed the whole process; `runHeadlessSpawn` captured it so a typed, actionable failure
 *    surfaces instead. Classified as a RETRYABLE `ProcessCrash` (distinct from the
 *    model-unavailable config error): a spawn that died transiently is worth re-running within
 *    the attempt budget rather than blocking after one attempt.
 */
const classifyPreExit = ({ session, exit, providerName }: ClassifySpawnExitInput): AttemptOutcome | undefined => {
  if (session.abortSignal?.aborted === true) {
    return {
      kind: 'error',
      error: new AbortError({
        elementName: providerName,
        reason: `${providerName}: aborted by caller`,
      }),
    };
  }

  if (exit.spawnError !== undefined) {
    return classifySpawnFailure(providerName, exit.spawnError, exit.argvBytes);
  }

  return undefined;
};

/**
 * Turn a spawn-level failure into an outcome. Shared by the pre-exit branch above and by the
 * synchronous-throw path in `runProviderAttempt` — `cross-spawn` raises an oversized command line
 * synchronously on Windows, so a classifier that only handled the async `'error'` event would let
 * exactly this bug escape as an unhandled exception.
 *
 * An argv overflow is NOT transient: the same command line is assembled on every attempt, so a
 * retryable `ProcessCrash` would burn the whole budget re-spawning something that can never fit.
 * It is also not a PATH problem, so the default hint would send an operator looking in the wrong
 * place. Non-retryable config error instead, carrying the measured size.
 *
 * That verdict is only safe when the size really did break the platform's ceiling, which is why
 * `platform` reaches {@link isArgvOverflow}: on darwin / linux a 40 KiB command line is legal, so a
 * failure at that size is an ordinary `ENOENT` / `EACCES` and MUST stay a retryable
 * `ProcessCrashError` with the PATH hint. Injectable for tests; defaults to the live platform.
 *
 * @public
 */
export const classifySpawnFailure = (
  providerName: ProviderName,
  cause: NodeJS.ErrnoException,
  argvBytes?: number,
  platform: NodeJS.Platform = process.platform
): AttemptOutcome => {
  const errno = errnoOf(cause);
  if (isArgvOverflow(errno, argvBytes ?? 0, platform)) {
    const hint = argvOverflowHint(argvBytes);
    return {
      kind: 'error',
      error: new InvalidStateError({
        entity: providerName,
        currentState: 'spawn-failed',
        attemptedAction: 'complete generation',
        message: `${providerName}: spawn failed: ${errno} — ${hint}`,
        hint,
      }),
    };
  }
  return {
    kind: 'error',
    error: new ProcessCrashError({
      entity: providerName,
      state: 'spawn-failed',
      message: `${providerName}: spawn failed: ${errno} — ${cause.message}`,
      hint: 'verify the provider CLI is installed and on PATH',
    }),
  };
};

/**
 * Which stream carried the rate-limit evidence — the two are NOT equally trustworthy, so the
 * ladder treats them differently (stderr beats signals-recovery, stdout does not).
 */
type RateLimitSource = 'stderr' | 'stdout';

/**
 * Rate-limit detection, two-tiered by haystack trustworthiness:
 *
 *  - **stderr** gets the adapter's own broad pattern — it is the CLI's diagnostic channel, so
 *    "quota" / a bare `429` there really is a throttle.
 *  - **stdoutTail** gets the shared, narrow {@link STDOUT_RATE_LIMIT_RE} — it is assistant prose,
 *    where those same tokens appear in ordinary answers about throttling code.
 *
 * Returns the matching source, or `undefined` when neither tier matches.
 */
const detectRateLimit = ({ stderr, rateLimitRe, stdoutTail }: ClassifySpawnExitInput): RateLimitSource | undefined => {
  if (rateLimitRe.test(stderr)) return 'stderr';
  if (stdoutTail !== undefined && STDOUT_RATE_LIMIT_RE.test(stdoutTail)) return 'stdout';
  return undefined;
};

/**
 * The rate-limit outcome. The message names the stream that matched: a `rate-limit` classification
 * costs the operator the whole backoff schedule, so which haystack triggered it has to be
 * readable from the log without re-running anything.
 */
const rateLimitOutcome = (
  { exit, capturedSessionId, providerName }: ClassifySpawnExitInput,
  source: RateLimitSource
): AttemptOutcome => ({
  kind: 'rate-limit',
  error: new RateLimitError({
    subCode: 'spawn-stderr',
    message: `${providerName}: rate-limit detected in ${source} (exit ${String(exit.code)})`,
    ...(capturedSessionId !== undefined ? { sessionId: capturedSessionId } : {}),
  }),
});

/**
 * **Model unavailable** is a configuration failure, not recoverable work. It wins over recovery
 * because a model-not-available exit means the run never produced valid work for this model; a
 * stale signals.json must not mask the real cause. The actionable hint is folded into `.message`
 * (not just the separate `.hint` field) so it survives unchanged through `run-generator-turn`'s
 * blockedReason string and into the TUI without touching the render layer.
 *
 * **Scans stderr + `processErrorText`, never `stdoutTail`.** Both of the former are the CLI's own
 * diagnostics (claude / codex / copilot use stderr; opencode uses a structured stdout error
 * record). `stdoutTail` is assistant-generated task output, where benign phrases like "the model
 * is not available in TensorFlow" or "the model checkpoint was not found" appear in NORMAL
 * responses and would be misclassified as a config failure.
 */
const classifyModelUnavailable = (input: ClassifySpawnExitInput): AttemptOutcome | undefined => {
  const { exit, stderr, processErrorText, providerName } = input;
  if (!MODEL_UNAVAILABLE_RE.test(stderr) && !MODEL_UNAVAILABLE_RE.test(processErrorText ?? '')) return undefined;

  const hint = 'model not available — it may not be on your plan or CLI version; pick another model in settings';
  return {
    kind: 'error',
    error: new InvalidStateError({
      entity: providerName,
      currentState: `exit-${String(exit.code ?? 'null')}`,
      attemptedAction: 'complete generation',
      message: `${providerName}: ${exitSummary(input)} — ${hint}`,
      hint,
    }),
  };
};

/**
 * Non-zero exit with no signals.json — the watchdog-SIGTERM-before-signals shape (idle-stdout kill
 * of a wedged child). A TRANSIENT process death worth retrying, so it surfaces a RETRYABLE
 * `ProcessCrash` (distinct from the non-retryable model-unavailable config error). The message
 * text keeps the historical per-adapter exit-N shape so logs / progress read the same.
 */
const crashOutcome = (input: ClassifySpawnExitInput): AttemptOutcome => {
  // Prefer the POSIX signal name when Node reported one — `SIGTERM` is more legible in the
  // attempt record than the `143` the same kill surfaces as under different timing.
  const signalOrExitCode = input.exit.signal ?? input.exit.code ?? undefined;
  return {
    kind: 'error',
    error: new ProcessCrashError({
      entity: input.providerName,
      state: `exit-${String(input.exit.code ?? 'null')}`,
      message: `${input.providerName}: ${exitSummary(input)}`,
      ...(signalOrExitCode !== null && signalOrExitCode !== undefined ? { signalOrExitCode } : {}),
      ...(input.watchdogKilled === true ? { watchdogKilled: true } : {}),
    }),
  };
};

/**
 * The only branch that touches the filesystem. `signals.json` is authoritative, so a non-zero exit
 * with the envelope on disk preserves the work: the watchdog banner is cleared, the adapter's own
 * success block runs, and `recoveredFromExit` is spliced in so the caller can tell it apart from a
 * clean exit. Existence-check only; the downstream validator catches malformed content.
 *
 * Returns `undefined` when nothing landed, so the ladder can decide between the weaker
 * (stdout-only) rate-limit evidence and a plain crash.
 */
const recoverIfSignalsLanded = async ({
  session,
  exit,
  providerName,
  eventBus,
  watchdogBannerId,
  onSuccess,
}: ClassifySpawnExitInput): Promise<AttemptOutcome | undefined> => {
  const exists = await pathExists(String(session.signalsFile));
  if (!exists.ok || !exists.value) return undefined;

  eventBus.publish({
    type: 'log',
    level: 'warn',
    message: `${providerName}: non-zero exit (code=${String(exit.code)}, signal=${String(exit.signal ?? 'null')}) but signals.json captured — preserving work`,
    meta: { code: exit.code, signal: exit.signal, providerName },
    at: IsoTimestamp.now(),
  });
  eventBus.publish({
    type: 'banner-clear',
    id: watchdogBannerId,
    at: IsoTimestamp.now(),
  });

  const outcome = await onSuccess();
  if (outcome.kind !== 'success') return outcome;
  return {
    kind: 'success',
    output: {
      ...outcome.output,
      recoveredFromExit: { code: exit.code, signal: exit.signal },
    },
  };
};

/**
 * The precedence ladder, in order:
 *
 *  1. the two pre-exit branches (abort, spawn error) beat everything;
 *  2. a clean exit hands straight to the adapter's success block;
 *  3. a rate-limit found on **stderr** beats signals-recovery (the CLI itself said "throttled");
 *  4. model-unavailable beats signals-recovery (a config error must not be masked by a stale
 *     envelope);
 *  5. signals-recovery beats a rate-limit found only in **stdoutTail** — a landed envelope is
 *     proof the turn did its work, and that haystack is assistant prose;
 *  6. otherwise a stdout-only rate-limit match still surfaces `rate-limit` (the real claude
 *     stream-json throttle shape, which never lands an envelope);
 *  7. everything else is a retryable crash.
 */
export const classifySpawnExit = async (input: ClassifySpawnExitInput): Promise<AttemptOutcome> => {
  const preExit = classifyPreExit(input);
  if (preExit !== undefined) return preExit;

  if (input.exit.code === 0) return await input.onSuccess();

  const rateLimitSource = detectRateLimit(input);
  if (rateLimitSource === 'stderr') return rateLimitOutcome(input, rateLimitSource);

  const modelUnavailable = classifyModelUnavailable(input);
  if (modelUnavailable !== undefined) return modelUnavailable;

  const recovered = await recoverIfSignalsLanded(input);
  if (recovered !== undefined) return recovered;

  if (rateLimitSource !== undefined) return rateLimitOutcome(input, rateLimitSource);

  return crashOutcome(input);
};
