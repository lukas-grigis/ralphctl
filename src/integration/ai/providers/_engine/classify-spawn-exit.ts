import { InvalidStateError, ProviderConfigRejection } from '@src/domain/value/error/invalid-state-error.ts';
import { ProcessCrashError } from '@src/domain/value/error/process-crash-error.ts';
import { RateLimitError } from '@src/domain/value/error/rate-limit-error.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import { pathExists } from '@src/integration/io/fs.ts';
import { argvOverflowHint, errnoOf, isArgvOverflow } from '@src/integration/ai/providers/_engine/argv-budget.ts';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import { type AttemptOutcome, abortedByCaller } from '@src/integration/ai/providers/_engine/attempt-outcome.ts';

/**
 * Broad rate-limit pattern for the CLI's own diagnostics (stderr, `processErrorText`): "quota" and a
 * bare `429` there really are throttles. Claude keeps its own pattern for its different wording.
 */
export const DEFAULT_RATE_LIMIT_RE = /rate.?limit|quota|\b429\b/i;

/**
 * Narrow rate-limit pattern for `stdoutTail`, which is ASSISTANT prose: the broad pattern matches
 * ordinary answers ("implemented the rate limiter", "retry on HTTP 429"), so any non-zero exit on a
 * task about throttling read as a throttle and slept through the backoff instead of recovering
 * `signals.json`. Only the vendors' real throttle sentences match here; bare `429` / `quota` do not.
 */
const STDOUT_RATE_LIMIT_RE =
  /usage limit reached|rate.?limit exceeded|rate_limit_error|overloaded_error|\b5-hour limit\b|"status"\s*:\s*429/i;

/**
 * Post-spawn classifier shared by the five headless adapters: success, rate-limit retry, abort, or
 * hard failure. The precedence ladder is documented on {@link classifySpawnExit}.
 *
 * - `signals.json` is authoritative: a non-zero exit (an idle-watchdog SIGTERM shows up as either
 *   `signal: 'SIGTERM'` or `code: 143`) with the envelope on disk still counts as landed work. Only
 *   existence is checked; `contract/_engine/validate-signals-file.ts` rejects bad content.
 * - Abort is classified first, so a cancel surfaces `AbortError` rather than an `InvalidStateError`
 *   a downstream guard could swallow.
 * - Crashes (spawn failed, non-zero exit with no envelope) are a retryable `ProcessCrashError`;
 *   model-unavailable and effort-unsupported are config errors (`InvalidStateError`) that must block
 *   after one attempt instead of burning the budget.
 */
export type ProviderSlug = 'claude' | 'codex' | 'copilot' | 'opencode' | 'grok';

export type ProviderName = `${ProviderSlug}-provider`;

/**
 * The CLI's "selected model isn't available" failure, anchored on the word `model`. Observed:
 * copilot `Model "x" from --model flag is not available.`, codex `model not found`, claude
 * `unknown model`. OpenCode's unreachable-id wording (`UnknownError: Unexpected server error.`) has
 * no `model` token and deliberately stays a retryable crash — a transient upstream outage reads the
 * same, so loosening this regex would turn a blip into a block.
 */
const MODEL_UNAVAILABLE_RE =
  /\bmodel\b[^\n]*\b(?:is\s+not\s+available|not\s+available|not\s+found)|\b(?:unknown|unsupported|invalid)\s+model\b/i;

/**
 * Matches a provider CLI rejecting the reasoning-effort level for the selected model. Observed:
 *  - copilot (stderr): `Error: Model "claude-haiku-4.5" does not support reasoning effort
 *    configuration (requested: "xhigh").` and `Error: Reasoning effort "max" is not supported for
 *    model "gpt-5-mini".`
 *  - codex (stdout error record, unwrapped by the adapter): `Unsupported value: 'max' is not
 *    supported with the 'gpt-5.5' model. … (param: reasoning.effort)`; the raw JSON envelope
 *    carries `"param": "reasoning.effort"`.
 *  - grok (the 1.0.62 binary's format strings): `Couldn't apply reasoning effort: …` and
 *    `--effort/--reasoning-effort: unknown effort level '<level>' …`.
 * Scanned on the same CLI-diagnostic haystacks as {@link MODEL_UNAVAILABLE_RE}, never `stdoutTail`.
 */
const EFFORT_UNSUPPORTED_RE =
  /does not support reasoning effort|reasoning effort\b[^\n]*\bnot supported|\bunsupported\b[^\n]*\breasoning\.effort\b|"param"\s*:\s*"reasoning\.effort"|couldn['’]t apply reasoning effort|unknown effort level/i;

const COMPLETE_GENERATION = 'complete generation';

export interface ClassifySpawnExitInput {
  readonly session: AiSession;
  readonly exit: {
    readonly code: number | null;
    readonly signal: string | null;
    /** The child never ran (missing binary, EACCES, died before stdin drained); code/signal mean nothing. */
    readonly spawnError?: NodeJS.ErrnoException;
    /** Attempted argv size — an overflow sometimes arrives as `ERROR_INVALID_PARAMETER`, not `ENAMETOOLONG`. */
    readonly argvBytes?: number;
  };
  readonly stderr: string;
  /** Adapter's broad throttle pattern, applied to stderr and `processErrorText` only. */
  readonly rateLimitRe: RegExp;
  /** Assistant-generated stdout tail: scanned only with {@link STDOUT_RATE_LIMIT_RE}, never for config errors. */
  readonly stdoutTail?: string;
  /**
   * The CLI's structured stdout error record, for CLIs whose fatal errors never reach stderr
   * (opencode, grok). Trusted like stderr: the message fallback and a config-error haystack.
   */
  readonly processErrorText?: string;
  /** Provider's best-effort captured session id, attached to `RateLimitError` when present. */
  readonly capturedSessionId?: string;
  readonly providerName: ProviderName;
  readonly eventBus: EventBus;
  /** Watchdog banner the recovery branch clears, so a stuck-process warning never sits beside a success. */
  readonly watchdogBannerId: string;
  /** The watchdog's own SIGTERM killed the child — indistinguishable from an external kill by exit shape. */
  readonly watchdogKilled?: boolean;
  /** Runs on a clean exit and on signals-recovery (which then splices in `recoveredFromExit`). */
  readonly onSuccess: () => AttemptOutcome | Promise<AttemptOutcome>;
}

/** Falls back to `processErrorText` when stderr is empty, so opencode's only explanation survives. */
const exitSummary = ({ exit, stderr, processErrorText }: ClassifySpawnExitInput): string => {
  const detail = stderr.trim() || processErrorText?.trim() || '<empty stderr>';
  return `process exited with code ${String(exit.code)}${exit.signal !== null ? ` (signal=${exit.signal})` : ''}: ${detail}`;
};

/** Abort, then spawn error — both decided before the exit code is looked at. */
const classifyPreExit = ({ session, exit, providerName }: ClassifySpawnExitInput): AttemptOutcome | undefined => {
  if (session.abortSignal?.aborted === true) return { kind: 'error', error: abortedByCaller(providerName) };
  if (exit.spawnError !== undefined) return classifySpawnFailure(providerName, exit.spawnError, exit.argvBytes);
  return undefined;
};

/**
 * Spawn-level failure, from the async `'error'` event or the synchronous throw `cross-spawn` raises
 * for an oversized Windows command line. An argv overflow is a non-retryable config error (the same
 * argv is rebuilt every attempt); `platform` keeps a 40 KiB argv on darwin / linux, where it is
 * legal, a retryable crash with the PATH hint.
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
        attemptedAction: COMPLETE_GENERATION,
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

/** stderr-class evidence beats signals-recovery; stdout-only evidence does not. */
type RateLimitSource = 'stderr' | 'stdout';

const detectRateLimit = ({
  stderr,
  rateLimitRe,
  stdoutTail,
  processErrorText,
}: ClassifySpawnExitInput): RateLimitSource | undefined => {
  if (rateLimitRe.test(stderr)) return 'stderr';
  if (processErrorText !== undefined && processErrorText.length > 0 && rateLimitRe.test(processErrorText)) {
    return 'stderr';
  }
  if (stdoutTail !== undefined && STDOUT_RATE_LIMIT_RE.test(stdoutTail)) return 'stdout';
  return undefined;
};

/** Names the matching stream: a rate-limit verdict costs the whole backoff schedule. */
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
 * Config failure that beats recovery, so a stale envelope cannot mask it. The hint is folded into
 * `.message` so it reaches the TUI through `blockedReason` untouched. Never scans `stdoutTail`:
 * "the model is not available in TensorFlow" is ordinary assistant prose.
 */
const classifyModelUnavailable = (input: ClassifySpawnExitInput): AttemptOutcome | undefined => {
  const { stderr, processErrorText, providerName } = input;
  if (!MODEL_UNAVAILABLE_RE.test(stderr) && !MODEL_UNAVAILABLE_RE.test(processErrorText ?? '')) return undefined;

  const hint = 'model not available — it may not be on your plan or CLI version; pick another model in settings';
  return {
    kind: 'error',
    error: new InvalidStateError({
      entity: providerName,
      currentState: ProviderConfigRejection.ModelUnavailable,
      attemptedAction: COMPLETE_GENERATION,
      message: `${providerName}: ${exitSummary(input)} — ${hint}`,
      hint,
    }),
  };
};

/**
 * The CLI rejected the effort level for this model — non-retryable like model-unavailable. Catches
 * custom ids the catalog clamp cannot; quotes the CLI's own line, not the whole (noisy) stderr.
 */
const classifyEffortUnsupported = (input: ClassifySpawnExitInput): AttemptOutcome | undefined => {
  const { session, stderr, processErrorText, providerName } = input;
  const cliLine = [stderr, processErrorText ?? '']
    .flatMap((text) => text.split('\n'))
    .find((line) => EFFORT_UNSUPPORTED_RE.test(line));
  if (cliLine === undefined) return undefined;

  const level = session.effort !== undefined ? ` "${session.effort}"` : '';
  const hint = 'set an effort level this model supports, or pick another model';
  return {
    kind: 'error',
    error: new InvalidStateError({
      entity: providerName,
      currentState: ProviderConfigRejection.EffortUnsupported,
      attemptedAction: COMPLETE_GENERATION,
      message: `${providerName}: model "${session.model}" doesn't support reasoning effort${level} — ${hint} (CLI: ${cliLine.trim()})`,
      hint,
    }),
  };
};

/** Non-zero exit with no envelope: a retryable crash. */
const crashOutcome = (input: ClassifySpawnExitInput): AttemptOutcome => {
  // `SIGTERM` reads better in the attempt record than the `143` the same kill can surface as.
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

/** Signals-recovery: `undefined` when no envelope landed. */
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
 *  3. a rate-limit found on **stderr** or **processErrorText** beats signals-recovery (the CLI
 *     itself said "throttled");
 *  4. a config rejection (effort-unsupported, then model-unavailable) beats signals-recovery (a
 *     config error must not be masked by a stale envelope);
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

  const configRejected = classifyEffortUnsupported(input) ?? classifyModelUnavailable(input);
  if (configRejected !== undefined) return configRejected;

  const recovered = await recoverIfSignalsLanded(input);
  if (recovered !== undefined) return recovered;

  if (rateLimitSource !== undefined) return rateLimitOutcome(input, rateLimitSource);

  return crashOutcome(input);
};
