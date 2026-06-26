import { AbortError } from '@src/domain/value/error/abort-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { RateLimitError } from '@src/domain/value/error/rate-limit-error.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import { pathExists } from '@src/integration/io/fs.ts';
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
 * Shared post-spawn classifier for the three headless AI provider adapters
 * (claude / codex / copilot). Inspects the child's exit, the abort signal, stderr, and the
 * presence of `signals.json`, and decides whether the attempt is a success, a rate-limit
 * retry, an aborted operation, or a hard failure.
 *
 * Why centralise: the same five-step decision tree was implicit (and partially wrong) in
 * every adapter. Two bugs surfaced that this helper fixes:
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
 */
export type ProviderName = 'claude-provider' | 'codex-provider' | 'copilot-provider';

/**
 * Matches the provider-CLI "the selected model isn't available" failure across the three
 * backends. Real-world wordings observed:
 *  - copilot: `Error: Model "gpt-5.4-nano" from --model flag is not available.`
 *  - codex:   `model not found`
 *  - claude:  `unknown model`
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

export const classifySpawnExit = async (input: ClassifySpawnExitInput): Promise<AttemptOutcome> => {
  const {
    session,
    exit,
    stderr,
    rateLimitRe,
    stdoutTail,
    capturedSessionId,
    providerName,
    eventBus,
    watchdogBannerId,
    onSuccess,
  } = input;

  // 1. Abort precedence. A user cancel that races a clean exit still surfaces as
  // AbortError so the chain runner can propagate it transparently per CLAUDE.md §267.
  if (session.abortSignal?.aborted === true) {
    return {
      kind: 'error',
      error: new AbortError({
        elementName: providerName,
        reason: `${providerName}: aborted by caller`,
      }),
    };
  }

  // 2. Spawn error precedence (before any exit-code branch). The child never ran — a missing /
  // non-executable binary (ENOENT / EACCES) or a death before stdin drained. Without this the
  // unhandled `'error'` event would have killed the whole process; runHeadlessSpawn captured it
  // so we surface a typed, actionable failure instead.
  if (exit.spawnError !== undefined) {
    const errno = exit.spawnError.code ?? exit.spawnError.name;
    return {
      kind: 'error',
      error: new InvalidStateError({
        entity: providerName,
        currentState: 'spawn-failed',
        attemptedAction: 'spawn provider CLI',
        message: `${providerName}: spawn failed: ${errno} — ${exit.spawnError.message}`,
        hint: 'verify the provider CLI is installed and on PATH',
      }),
    };
  }

  // 3. Clean exit — adapter's own success block owns the data plumbing.
  if (exit.code === 0) {
    return await onSuccess();
  }

  // 4. Rate-limit — backoff/retry takes precedence over signals-recovery. Scan stderr AND any
  // provider-parsed stdout error body: claude's stream-json mode reports quota in stdout, not
  // stderr, so a stderr-only scan misses the most common real-world throttle.
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

  // 5. Model unavailable — a configuration failure, not recoverable work. It wins over
  // signals-recovery because a model-not-available exit means the run never produced valid work
  // for this model; a stale signals.json must not mask the real cause. The actionable hint is
  // folded into `.message` (not just the separate `.hint` field) so it survives unchanged through
  // `run-generator-turn`'s blockedReason string and into the TUI without touching the render layer.
  //
  // **stderr ONLY (unlike rate-limit).** All three provider CLIs report model-availability errors
  // on stderr. Scanning `stdoutTail` here would be a false-positive hazard: stdoutTail carries
  // assistant-generated task output (Claude envelope body / Copilot event text / Codex agent
  // message), where benign phrases like "the model is not available in TensorFlow" or "the model
  // checkpoint was not found" appear in NORMAL responses and would be misclassified as a config
  // failure. The rate-limit branch above legitimately needs stdoutTail (claude reports quota in
  // its stream-json result envelope); model-availability has no such stdout-only case.
  if (MODEL_UNAVAILABLE_RE.test(stderr)) {
    const hint = 'model not available — it may not be on your plan or CLI version; pick another model in settings';
    return {
      kind: 'error',
      error: new InvalidStateError({
        entity: providerName,
        currentState: `exit-${String(exit.code ?? 'null')}`,
        attemptedAction: 'complete generation',
        message: `${providerName}: process exited with code ${String(exit.code)}${exit.signal !== null ? ` (signal=${exit.signal})` : ''}: ${stderr.trim() || '<empty stderr>'} — ${hint}`,
        hint,
      }),
    };
  }

  // 6. Recovery — audit-[09]: signals.json is authoritative. Existence-check only; the
  // downstream validator catches malformed content.
  const exists = await pathExists(String(session.signalsFile));
  if (exists.ok && exists.value) {
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
    if (outcome.kind === 'success') {
      return {
        kind: 'success',
        output: {
          ...outcome.output,
          recoveredFromExit: { code: exit.code, signal: exit.signal },
        },
      };
    }
    return outcome;
  }

  // 7. Hard fail. Mirrors the historical per-adapter exit-N error shape.
  return {
    kind: 'error',
    error: new InvalidStateError({
      entity: providerName,
      currentState: `exit-${String(exit.code ?? 'null')}`,
      attemptedAction: 'complete generation',
      message: `${providerName}: process exited with code ${String(exit.code)}${exit.signal !== null ? ` (signal=${exit.signal})` : ''}: ${stderr.trim() || '<empty stderr>'}`,
    }),
  };
};
