import type { Result } from '@src/domain/result.ts';
import type { HeadlessAiProvider, ProviderUsage } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import { STDERR_TAIL_CAP, createBoundedTail } from '@src/integration/ai/providers/_engine/bounded-tail.ts';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { ProviderSpawn } from '@src/integration/ai/providers/_engine/spawn.ts';
import { runHeadlessSpawn } from '@src/integration/ai/providers/_engine/run-headless-spawn.ts';
import { runWithRateLimitRetry } from '@src/integration/ai/providers/_engine/run-with-rate-limit-retry.ts';
import { writeTextAtomic } from '@src/integration/io/fs.ts';
import { persistSessionIdFile } from '@src/integration/ai/providers/_engine/persist-session-id.ts';
import { contextWindowFor } from '@src/integration/ai/providers/_engine/context-window.ts';
import type { AttemptOutcome } from '@src/integration/ai/providers/_engine/attempt-outcome.ts';
import {
  classifySpawnExit,
  classifySpawnFailure,
  type ProviderName,
} from '@src/integration/ai/providers/_engine/classify-spawn-exit.ts';
import { argvByteLength } from '@src/integration/ai/providers/_engine/argv-budget.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';

export type { ProviderName };

/**
 * Token-usage payload supplied by each provider adapter. Fields map directly to the
 * `TokenUsageEvent` shape; each provider fills only the subset it captures from its CLI stream.
 */
export interface TokenUsagePayload {
  readonly provider: 'claude-code' | 'openai-codex' | 'github-copilot' | 'opencode';
  readonly model?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheCreationTokens?: number;
  readonly liveInputTokens?: number;
  readonly liveCacheReadTokens?: number;
  readonly liveCacheCreationTokens?: number;
}

/**
 * Emit the per-spawn "session id captured" debug log. All three adapters publish the same
 * event shape; only the provider-name prefix and the captured id differ.
 */
export const emitSessionIdCaptured = (eventBus: EventBus, providerName: string, sessionId: string): void => {
  eventBus.publish({
    type: 'log',
    level: 'debug',
    message: `${providerName}: session id captured`,
    meta: { sessionId },
    at: IsoTimestamp.now(),
  });
};

/**
 * Emit one `TokenUsageEvent` per success spawn. Handles the contextWindowFor lookup,
 * chainSessionId / role threading, and all optional field spreads so each provider just
 * passes its own payload fields.
 *
 * Returns the payload it published so the caller can ALSO hand the counts back as data (see
 * `ProviderAttemptInput.emitProviderTokenUsage`) — the event alone is ephemeral, and the chain
 * needs the same figures to persist them onto the attempt.
 */
export const emitTokenUsage = (
  eventBus: EventBus,
  session: AiSession,
  sessionId: string,
  payload: TokenUsagePayload
): TokenUsagePayload => {
  const window = contextWindowFor(payload.model);
  const chainSessionId = session.chainSessionId;
  eventBus.publish({
    type: 'token-usage',
    sessionId,
    ...(chainSessionId !== undefined ? { chainSessionId } : {}),
    provider: payload.provider,
    ...(payload.model !== undefined ? { model: payload.model } : {}),
    ...(payload.inputTokens !== undefined ? { inputTokens: payload.inputTokens } : {}),
    ...(payload.outputTokens !== undefined ? { outputTokens: payload.outputTokens } : {}),
    ...(payload.cacheReadTokens !== undefined ? { cacheReadTokens: payload.cacheReadTokens } : {}),
    ...(payload.cacheCreationTokens !== undefined ? { cacheCreationTokens: payload.cacheCreationTokens } : {}),
    ...(payload.liveInputTokens !== undefined ? { liveInputTokens: payload.liveInputTokens } : {}),
    ...(payload.liveCacheReadTokens !== undefined ? { liveCacheReadTokens: payload.liveCacheReadTokens } : {}),
    ...(payload.liveCacheCreationTokens !== undefined
      ? { liveCacheCreationTokens: payload.liveCacheCreationTokens }
      : {}),
    ...(window !== undefined ? { contextWindow: window } : {}),
    ...(session.role !== undefined ? { role: session.role } : {}),
    at: IsoTimestamp.now(),
  });
  return payload;
};

/**
 * Per-attempt spawn configuration. Each provider supplies its stdout consumer, flush callback,
 * state getters, and token-usage emitter; the shared scaffold owns the child lifecycle, bounded
 * tails, watchdog banner, `runHeadlessSpawn` wiring, `onSuccess` plumbing, and
 * `classifySpawnExit` call.
 */
export interface ProviderAttemptInput {
  readonly spawnFn: ProviderSpawn;
  readonly command: string;
  readonly args: readonly string[];
  readonly session: AiSession;
  readonly resolveOn: 'exit' | 'close';
  /**
   * Prompt piped to stdin. Omit for providers (Copilot) that pass the prompt as an argv
   * argument — `runHeadlessSpawn` closes stdin immediately when this field is absent.
   */
  readonly stdin?: string;
  readonly rateLimitRe: RegExp;
  /** Receives each raw stdout chunk. */
  readonly onStdoutChunk: (chunk: string) => void;
  /**
   * Flush any trailing partial-line state after `runHeadlessSpawn` resolves so no JSONL
   * record is lost to a missing terminal newline.
   */
  readonly flush: () => void;
  /** Returns the session id captured from the stream (called after flush). */
  readonly getSessionId: () => string | undefined;
  /** Returns the stdout body tail for the rate-limit haystack, or undefined to scan stderr only. */
  readonly getStdoutTail: () => string | undefined;
  /**
   * Returns the assistant body for `bodyFile` mirroring. Only called when `session.bodyFile`
   * is set. Forensic capture is best-effort across all providers — an unreadable body resolves to
   * an empty string rather than a failure Result, so it never discards an otherwise-recovered
   * success (`signals.json` is the authoritative gate). A non-`AbortError` failure Result here
   * would still surface as a hard error from `onSuccess`.
   */
  readonly getBody: () => Promise<Result<string, DomainError>>;
  /**
   * Emit the provider-specific token-usage event for this attempt's captured sessionId. Called
   * from `onSuccess` only when `sessionId` is defined. Returns the payload it published so the
   * scaffold can also fold the counts into {@link ProviderOutput.usage} — the event is ephemeral,
   * the returned data is what the chain persists onto the attempt.
   */
  readonly emitProviderTokenUsage: (sessionId: string) => TokenUsagePayload;
  readonly providerName: ProviderName;
  readonly providerSlug: 'claude' | 'codex' | 'copilot' | 'opencode';
  readonly eventBus: EventBus;
  readonly idleMs?: number;
}

/**
 * Shared spawnAttempt scaffold for the three headless AI provider adapters. Owns:
 *
 * - Child spawn with cwd (context-file autoload depends on the child's `process.cwd()`).
 * - Bounded stderr tail (`STDERR_TAIL_CAP`).
 * - Watchdog banner id keyed by `watchdog-<slug>-<pid>`.
 * - `runHeadlessSpawn` wiring — onStdout / onStderr / stdin / resolveOn / idleMs /
 *   abortSignal / onIdle (idle-watchdog warn + banner-show).
 * - `onSuccess` plumbing — `emitSessionIdCaptured`, `emitProviderTokenUsage`,
 *   `persistSessionIdFile`, bodyFile mirror.
 * - `classifySpawnExit` call with provider-specific rateLimitRe and stdoutTail.
 *
 * Each provider supplies only what genuinely differs: argv, stdout chunk consumer, flush
 * callback, sessionId / stdoutTail / body getters, and token-usage payload.
 */
/**
 * Idle-watchdog telemetry for one attempt: the `onIdle` callback `runHeadlessSpawn` fires when
 * the child goes quiet, plus the spawn options that carry the threshold. Folding both into one
 * factory keeps the `idleMs !== undefined` conditional in a single place — the warn log, the
 * banner copy, and the spawn option all derive from the same optional threshold.
 */
const createIdleTelemetry = (
  input: ProviderAttemptInput,
  watchdogBannerId: string
): { readonly spawnOption: { readonly idleMs?: number }; readonly onIdle: () => void } => {
  const { idleMs, providerName, providerSlug, eventBus } = input;
  const forMs = idleMs !== undefined ? ` for ${String(idleMs)}ms` : '';
  const idleSuffix = idleMs !== undefined ? ` (${String(Math.round(idleMs / 1000))}s idle)` : '';
  return {
    spawnOption: idleMs !== undefined ? { idleMs } : {},
    onIdle: () => {
      eventBus.publish({
        type: 'log',
        level: 'warn',
        message: `${providerName}: no stdio activity${forMs} — killing wedged child`,
        ...(idleMs !== undefined ? { meta: { idleMs } } : {}),
        at: IsoTimestamp.now(),
      });
      eventBus.publish({
        type: 'banner-show',
        id: watchdogBannerId,
        tier: 'warn',
        message: `Watchdog killed stuck ${providerSlug} process${idleSuffix}`,
        at: IsoTimestamp.now(),
      });
    },
  };
};

/** Best-effort `sessionId.txt` write; a failure only degrades resume re-attach, never the run. */
const persistSessionId = async (input: ProviderAttemptInput, sessionId: string | undefined): Promise<void> => {
  const wrote = await persistSessionIdFile(input.session.signalsFile, sessionId);
  if (wrote === undefined || wrote.ok) return;
  input.eventBus.publish({
    type: 'log',
    level: 'warn',
    message: `${input.providerName}: failed to write sessionId file — resume re-attach may need log parsing`,
    meta: { error: wrote.error.message },
    at: IsoTimestamp.now(),
  });
};

/**
 * Mirror the assistant body to `session.bodyFile` for forensic capture. Returns the failing
 * `DomainError` only when the provider's own body getter failed — an unwritable mirror is logged
 * and swallowed, because `signals.json` (not body.txt) is the authoritative success gate.
 */
const mirrorBodyFile = async (input: ProviderAttemptInput): Promise<DomainError | undefined> => {
  const { session, providerName, eventBus } = input;
  if (session.bodyFile === undefined) return undefined;
  const bodyResult = await input.getBody();
  if (!bodyResult.ok) return bodyResult.error;
  const wrote = await writeTextAtomic(String(session.bodyFile), bodyResult.value);
  if (!wrote.ok) {
    eventBus.publish({
      type: 'log',
      level: 'warn',
      message: `${providerName}: failed to write body file — diagnostic capture skipped`,
      meta: { bodyFile: String(session.bodyFile), error: wrote.error.message },
      at: IsoTimestamp.now(),
    });
  }
  return undefined;
};

/**
 * Build the `onSuccess` block `classifySpawnExit` invokes on a clean exit AND on the
 * signals-recovery branch: session-id telemetry, `sessionId.txt`, the body-file mirror, and the
 * `ProviderOutput` envelope.
 *
 * `startedAtMs` is the pre-spawn clock read — the returned {@link ProviderUsage} carries the
 * elapsed wall-clock alongside whatever token counts the provider reported, so the chain can
 * persist per-attempt cost instead of only rendering it in the TUI.
 */
const createSuccessHandler =
  (input: ProviderAttemptInput, sessionId: string | undefined, code: number | null, startedAtMs: number) =>
  async (): Promise<AttemptOutcome> => {
    let usage: ProviderUsage = { durationMs: Date.now() - startedAtMs };
    if (sessionId !== undefined) {
      emitSessionIdCaptured(input.eventBus, input.providerName, sessionId);
      const reported = input.emitProviderTokenUsage(sessionId);
      usage = {
        ...usage,
        ...(reported.inputTokens !== undefined ? { inputTokens: reported.inputTokens } : {}),
        ...(reported.outputTokens !== undefined ? { outputTokens: reported.outputTokens } : {}),
      };
    }
    await persistSessionId(input, sessionId);
    const bodyError = await mirrorBodyFile(input);
    if (bodyError !== undefined) return { kind: 'error', error: bodyError };
    return {
      kind: 'success',
      output: {
        signalsFile: input.session.signalsFile,
        exitCode: code ?? 0,
        ...(sessionId !== undefined ? { sessionId } : {}),
        usage,
      },
    };
  };

export const runProviderAttempt = async (input: ProviderAttemptInput): Promise<AttemptOutcome> => {
  const { spawnFn, command, args, session, resolveOn, rateLimitRe, providerName, providerSlug, eventBus } = input;

  const argvBytes = argvByteLength(command, args);
  // Read BEFORE the spawn so the recorded duration covers the child's whole life, including the
  // synchronous-throw path's absence of one.
  const startedAtMs = Date.now();

  // `crossPlatformSpawn` throws synchronously for a command line the OS refuses outright — an
  // oversized argv on Windows arrives this way, not as an `'error'` event — so an uncaught call
  // here would take the whole process down instead of failing the attempt.
  let child;
  try {
    child = spawnFn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'] as const,
      cwd: String(session.cwd),
    });
  } catch (cause) {
    return classifySpawnFailure(providerName, cause as NodeJS.ErrnoException, argvBytes);
  }

  const stderrTail = createBoundedTail(STDERR_TAIL_CAP);
  const watchdogBannerId = `watchdog-${providerSlug}-${String(child.pid ?? 'unknown')}`;
  const idle = createIdleTelemetry(input, watchdogBannerId);

  const { code, signal, spawnError } = await runHeadlessSpawn({
    child,
    onStdout: (chunk) => {
      input.onStdoutChunk(chunk);
    },
    onStderr: (chunk) => {
      stderrTail.append(chunk);
    },
    ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
    resolveOn,
    ...idle.spawnOption,
    ...(session.abortSignal !== undefined ? { abortSignal: session.abortSignal } : {}),
    onIdle: idle.onIdle,
  });
  input.flush();

  const sessionId = input.getSessionId();
  const stdoutTail = input.getStdoutTail();
  return classifySpawnExit({
    session,
    // `spawnError` was previously dropped here, which left the classifier's spawn-error branch
    // unreachable from this path — a missing binary read as a plain non-zero exit.
    exit: { code, signal, argvBytes, ...(spawnError !== undefined ? { spawnError } : {}) },
    stderr: stderrTail.value(),
    rateLimitRe,
    ...(stdoutTail !== undefined && stdoutTail.length > 0 ? { stdoutTail } : {}),
    ...(sessionId !== undefined ? { capturedSessionId: sessionId } : {}),
    providerName,
    eventBus,
    watchdogBannerId,
    onSuccess: createSuccessHandler(input, sessionId, code, startedAtMs),
  });
};

/**
 * Context created once per `generate()` call. Provides the attempt function (called for each
 * retry) and optional cleanup run in a `finally` block after all attempts complete.
 *
 * Allows per-generate state (e.g. codex's output tempfile path) to be created once and shared
 * across retries, while per-attempt stream state is created fresh inside `attempt`.
 */
export interface GenerateContext {
  readonly attempt: (session: AiSession) => Promise<AttemptOutcome>;
  readonly cleanup?: () => Promise<void>;
}

export interface CreateHeadlessProviderInput {
  readonly providerSlug: 'claude' | 'codex' | 'copilot' | 'opencode';
  readonly providerName: ProviderName;
  readonly resumeStaleRe: RegExp;
  readonly rateLimitRetries: number;
  readonly eventBus: EventBus;
  readonly backoffSchedule?: readonly number[];
  /**
   * Called once at the start of each `generate()` call. Creates per-generate state (e.g.
   * codex's output tempfile path) and returns the per-attempt function and optional cleanup.
   * The attempt function is called once per retry; cleanup runs once after all attempts.
   */
  readonly createGenerateContext: () => GenerateContext;
}

/**
 * Factory for the identical generate()->runWithRateLimitRetry boilerplate shared by all three
 * headless provider adapters. Each adapter passes a `createGenerateContext` thunk that closes
 * over its own resolved deps (spawnFn, command, etc.) so the factory stays dependency-free
 * on provider-specific types.
 */
export const createHeadlessProvider = (config: CreateHeadlessProviderInput): HeadlessAiProvider => ({
  async generate(session) {
    const ctx = config.createGenerateContext();
    try {
      return await runWithRateLimitRetry({
        session,
        rateLimitRetries: config.rateLimitRetries,
        ...(config.backoffSchedule !== undefined ? { backoffSchedule: config.backoffSchedule } : {}),
        eventBus: config.eventBus,
        providerSlug: config.providerSlug,
        providerName: config.providerName,
        resumeStaleRe: config.resumeStaleRe,
        attempt: ctx.attempt,
      });
    } finally {
      await ctx.cleanup?.();
    }
  },
});
