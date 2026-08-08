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
 * Shared post-spawn classifier for the four headless AI provider adapters
 * (claude / codex / copilot / opencode). Inspects the child's exit, the abort signal, stderr, and the
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
 * **Rate-limit wins over recovery.** If stderr matches the rate-limit regex, surface
 * `rate-limit` — backoff/retry is the right response even if a partial `signals.json` from
 * a previous attempt happens to be on disk (per-round outputDir means it shouldn't be, but
 * the precedence keeps the semantics safe under reuse).
 *
 * **Retryable crash vs. non-retryable config error.** Two failure branches surface a
 * `ProcessCrashError` (a TRANSIENT process death worth retrying within the attempt budget):
 * spawn-failed (the child never ran) and non-zero exit with no signals.json (the idle-stdout
 * watchdog SIGTERM shape). Both let the harness re-run the generator and only block once
 * `maxAttempts` is exhausted. Model-unavailable deliberately stays an `InvalidStateError`: a
 * model-availability failure is a CONFIG error, so retrying just burns the whole budget on the
 * same misconfiguration — it must keep blocking after one attempt.
 */
export type ProviderName = 'claude-provider' | 'codex-provider' | 'copilot-provider' | 'opencode-provider';

/**
 * Matches the provider-CLI "the selected model isn't available" failure across the backends that
 * report it on stderr. Real-world wordings observed:
 *  - copilot:  `Error: Model "gpt-5.4-nano" from --model flag is not available.`
 *  - codex:    `model not found`
 *  - claude:   `unknown model`
 *  - opencode: NOT DETECTABLE HERE. An unreachable `provider/model` id exits 1 with EMPTY stderr
 *    and reports `{"type":"error","error":{"name":"UnknownError","data":{"message":"Unexpected
 *    server error. …"}}}` on stdout (verified against opencode v1.18.15) — neither output mode
 *    carries the word `model`, so this regex cannot match and the exit necessarily falls through
 *    to the retryable ProcessCrash branch. Widening the pattern would not help; the token simply
 *    isn't there.
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
   * Matched against the rate-limit haystack to detect a 429 / quota throttle. The haystack is
   * `stderr` plus any provider-parsed stdout error body the adapter passes via `stdoutTail`:
   * Claude's `-p stream-json` mode reports quota errors in the stdout `result` envelope, not on
   * stderr, so a stderr-only scan misses the most common real-world throttle shape. Producer of
   * the regex is the adapter (per-provider wording differs).
   */
  readonly rateLimitRe: RegExp;
  /**
   * Provider-parsed stdout error / result body, concatenated onto `stderr` before the
   * rate-limit regex runs. Lets a provider that surfaces quota messages in its stdout JSON
   * envelope (claude stream-json `result`, copilot/codex result records) still trip the
   * overnight backoff. Optional — adapters whose throttle wording always lands on stderr omit it.
   */
  readonly stdoutTail?: string;
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
   * Per-provider success block — emits token-usage, persists session-id.txt, mirrors
   * bodyFile, and returns `{ kind: 'success', output: ProviderOutput }`. Invoked on
   * `code === 0` AND on the recovery branch. When recovery fired, the helper splices
   * `recoveredFromExit` into the returned `output` so the caller can tell the two apart.
   */
  readonly onSuccess: () => AttemptOutcome | Promise<AttemptOutcome>;
}

/** Shared `code=N (signal=S): <stderr tail>` prefix used by both non-zero-exit failure shapes. */
const exitSummary = (exit: ClassifySpawnExitInput['exit'], stderr: string): string =>
  `process exited with code ${String(exit.code)}${exit.signal !== null ? ` (signal=${exit.signal})` : ''}: ${stderr.trim() || '<empty stderr>'}`;

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
 * @public
 */
export const classifySpawnFailure = (
  providerName: ProviderName,
  cause: NodeJS.ErrnoException,
  argvBytes?: number
): AttemptOutcome => {
  const errno = errnoOf(cause);
  if (isArgvOverflow(errno, argvBytes ?? 0)) {
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
 * The two non-zero-exit branches that BEAT signals-recovery. Returns `undefined` when neither
 * applies and the exit should fall through to recovery. Pure and synchronous.
 *
 *  - **Rate-limit** wins over recovery because backoff/retry is the right response even if a
 *    partial `signals.json` from a previous attempt happens to be on disk. The haystack is
 *    stderr PLUS any provider-parsed stdout error body: claude's stream-json mode reports quota
 *    in stdout, not stderr, so a stderr-only scan misses the most common real-world throttle.
 *  - **Model unavailable** is a configuration failure, not recoverable work. It wins over
 *    recovery because a model-not-available exit means the run never produced valid work for
 *    this model; a stale signals.json must not mask the real cause. The actionable hint is
 *    folded into `.message` (not just the separate `.hint` field) so it survives unchanged
 *    through `run-generator-turn`'s blockedReason string and into the TUI without touching the
 *    render layer.
 *
 *    **stderr ONLY (unlike rate-limit).** The claude / codex / copilot CLIs report
 *    model-availability errors on stderr; opencode does NOT (see the note on
 *    `MODEL_UNAVAILABLE_RE` — empty stderr, a generic error record on stdout), so an opencode
 *    model-availability failure is classified as a retryable crash rather than a config error.
 *    Scanning `stdoutTail` to compensate would be a false-positive hazard: stdoutTail
 *    carries assistant-generated task output (Claude envelope body / Copilot event text / Codex
 *    agent message), where benign phrases like "the model is not available in TensorFlow" or
 *    "the model checkpoint was not found" appear in NORMAL responses and would be misclassified
 *    as a config failure. The rate-limit branch legitimately needs stdoutTail (claude reports
 *    quota in its stream-json result envelope); opencode's stdout error record is deliberately
 *    left unscanned for exactly the reason above — it carries no `model` token to anchor on, so
 *    scanning it would buy nothing and cost false positives.
 */
const classifyFailureExit = ({
  exit,
  stderr,
  rateLimitRe,
  stdoutTail,
  capturedSessionId,
  providerName,
}: ClassifySpawnExitInput): AttemptOutcome | undefined => {
  const rateLimitHaystack = stdoutTail !== undefined ? `${stderr}\n${stdoutTail}` : stderr;
  if (rateLimitRe.test(rateLimitHaystack)) {
    return {
      kind: 'rate-limit',
      error: new RateLimitError({
        subCode: 'spawn-stderr',
        message: `${providerName}: rate-limit detected in stderr (exit ${String(exit.code)})`,
        ...(capturedSessionId !== undefined ? { sessionId: capturedSessionId } : {}),
      }),
    };
  }

  if (MODEL_UNAVAILABLE_RE.test(stderr)) {
    const hint = 'model not available — it may not be on your plan or CLI version; pick another model in settings';
    return {
      kind: 'error',
      error: new InvalidStateError({
        entity: providerName,
        currentState: `exit-${String(exit.code ?? 'null')}`,
        attemptedAction: 'complete generation',
        message: `${providerName}: ${exitSummary(exit, stderr)} — ${hint}`,
        hint,
      }),
    };
  }

  return undefined;
};

/**
 * The tail of the ladder, and the only branch that touches the filesystem.
 *
 *  - **Recovery** — signals.json is authoritative, so a non-zero exit with the envelope on disk
 *    preserves the work: the watchdog banner is cleared, the adapter's own success block runs,
 *    and `recoveredFromExit` is spliced in so the caller can tell it apart from a clean exit.
 *    Existence-check only; the downstream validator catches malformed content.
 *  - **Hard fail** — non-zero exit with no signals.json. This is the
 *    watchdog-SIGTERM-before-signals shape (idle-stdout kill of a wedged child): a TRANSIENT
 *    process death worth retrying, so it surfaces a RETRYABLE `ProcessCrash` (distinct from the
 *    non-retryable model-unavailable config error). The message text is unchanged from the
 *    historical per-adapter exit-N shape so logs / progress read the same.
 */
const recoverOrCrash = async ({
  session,
  exit,
  stderr,
  providerName,
  eventBus,
  watchdogBannerId,
  onSuccess,
}: ClassifySpawnExitInput): Promise<AttemptOutcome> => {
  const exists = await pathExists(String(session.signalsFile));
  if (!exists.ok || !exists.value) {
    return {
      kind: 'error',
      error: new ProcessCrashError({
        entity: providerName,
        state: `exit-${String(exit.code ?? 'null')}`,
        message: `${providerName}: ${exitSummary(exit, stderr)}`,
      }),
    };
  }

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
 * The precedence ladder, in order: the two pre-exit branches (abort, spawn error) beat everything;
 * a clean exit hands straight to the adapter's success block; the two failure branches
 * (rate-limit, model unavailable) beat signals-recovery; everything else recovers-or-crashes.
 */
export const classifySpawnExit = async (input: ClassifySpawnExitInput): Promise<AttemptOutcome> => {
  const preExit = classifyPreExit(input);
  if (preExit !== undefined) return preExit;

  if (input.exit.code === 0) return await input.onSuccess();

  const failure = classifyFailureExit(input);
  if (failure !== undefined) return failure;

  return await recoverOrCrash(input);
};
