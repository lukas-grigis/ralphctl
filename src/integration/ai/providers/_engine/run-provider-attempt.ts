import type { Result } from '@src/domain/result.ts';
import type { AiProvider } from '@src/domain/entity/settings.ts';
import type { HeadlessAiProvider, ProviderUsage } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import { STDERR_TAIL_CAP, createBoundedTail } from '@src/integration/ai/providers/_engine/bounded-tail.ts';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { type ProviderSpawn, defaultProviderSpawn } from '@src/integration/ai/providers/_engine/spawn.ts';
import type { HeadlessProviderDeps } from '@src/integration/ai/providers/_engine/headless-provider-deps.ts';
import { runHeadlessSpawn } from '@src/integration/ai/providers/_engine/run-headless-spawn.ts';
import { runWithRateLimitRetry } from '@src/integration/ai/providers/_engine/run-with-rate-limit-retry.ts';
import { writeTextAtomic } from '@src/integration/io/fs.ts';
import { persistSessionIdBestEffort } from '@src/integration/ai/providers/_engine/persist-session-id.ts';
import { contextWindowFor } from '@src/integration/ai/providers/_engine/context-window.ts';
import type { AttemptOutcome } from '@src/integration/ai/providers/_engine/attempt-outcome.ts';
import {
  classifySpawnExit,
  classifySpawnFailure,
  type ProviderName,
  type ProviderSlug,
} from '@src/integration/ai/providers/_engine/classify-spawn-exit.ts';
import { argvByteLength } from '@src/integration/ai/providers/_engine/argv-budget.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  NOOP_CHILD_REGISTRY,
  type ChildRegistry,
  type RegisteredChildHandle,
} from '@src/integration/ai/providers/_engine/child-registry.ts';
import { processGroupOf } from '@src/integration/io/kill-process-tree.ts';

export type { ProviderName, ProviderSlug };

/**
 * Token-usage payload supplied by each provider adapter. Fields map directly to the
 * `TokenUsageEvent` shape; each provider fills only the subset it captures from its CLI stream.
 */
export interface TokenUsagePayload {
  readonly provider: AiProvider;
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
 * Emit the per-spawn "session id captured" debug log. All five adapters publish the same
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
   * Returns the CLI's own structured error record, for providers that report fatal errors on
   * stdout with an EMPTY stderr (opencode). Feeds `classifySpawnExit`'s `processErrorText`, which
   * uses it as the failure-message fallback and as a model-unavailable haystack. Omit for
   * providers whose fatal errors land on stderr — the classifier already reads those.
   */
  readonly getProcessErrorText?: () => string | undefined;
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
  readonly providerSlug: ProviderSlug;
  readonly eventBus: EventBus;
  readonly idleMs?: number;
  /** Where the spawned child is announced for orphan reaping and the live-run record. */
  readonly childRegistry?: ChildRegistry;
}

const PROVIDER_BY_SLUG: Readonly<Record<ProviderSlug, AiProvider>> = {
  claude: 'claude-code',
  codex: 'openai-codex',
  copilot: 'github-copilot',
  opencode: 'opencode',
  grok: 'xai-grok',
};

const registerChild = (
  input: ProviderAttemptInput,
  child: ChildProcessWithoutNullStreams
): RegisteredChildHandle | undefined => {
  if (typeof child.pid !== 'number' || child.pid <= 0) return undefined;
  const pgid = processGroupOf(child);
  return (input.childRegistry ?? NOOP_CHILD_REGISTRY).register({
    pid: child.pid,
    ...(pgid !== undefined ? { pgid } : {}),
    provider: PROVIDER_BY_SLUG[input.providerSlug],
    command: input.command,
    cwd: String(input.session.cwd),
    ...(input.session.role !== undefined ? { role: input.session.role } : {}),
    signalsFile: String(input.session.signalsFile),
  });
};

/**
 * Shared spawnAttempt scaffold for the five headless AI provider adapters. Owns:
 *
 * - Child spawn with cwd (context-file autoload depends on the child's `process.cwd()`).
 * - Bounded stderr tail (`STDERR_TAIL_CAP`).
 * - Watchdog banner id keyed by `watchdog-<slug>-<pid>`.
 * - `runHeadlessSpawn` wiring — onStdout / onStderr / stdin / resolveOn / idleMs /
 *   abortSignal / onIdle (idle-watchdog warn + banner-show).
 * - `onSuccess` plumbing — `emitSessionIdCaptured`, `emitProviderTokenUsage`,
 *   `persistSessionIdBestEffort`, bodyFile mirror.
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
): {
  readonly spawnOption: { readonly idleMs?: number };
  readonly onIdle: () => void;
  /**
   * `true` once {@link onIdle} has fired — i.e. the SIGTERM this child dies from is OURS.
   * Read after the spawn settles so the classifier can attribute the crash to the watchdog
   * instead of guessing from an exit shape an external kill produces identically.
   */
  readonly killedByWatchdog: () => boolean;
} => {
  const { idleMs, providerName, providerSlug, eventBus } = input;
  const forMs = idleMs !== undefined ? ` for ${String(idleMs)}ms` : '';
  const idleSuffix = idleMs !== undefined ? ` (${String(Math.round(idleMs / 1000))}s idle)` : '';
  let killedByWatchdog = false;
  return {
    spawnOption: idleMs !== undefined ? { idleMs } : {},
    killedByWatchdog: () => killedByWatchdog,
    onIdle: () => {
      killedByWatchdog = true;
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

/**
 * Persist the provider's session id the moment the stream yields it — `session-id.txt` plus the
 * live-run record — so a harness killed mid-spawn still leaves a resumable thread on disk. Checked
 * after every stdout chunk; writes are chained so a (rare) id change never lands out of order.
 */
const createSessionIdCapture = (
  input: ProviderAttemptInput,
  registered: RegisteredChildHandle | undefined
): { readonly onChunk: () => void; readonly settled: () => Promise<string | undefined> } => {
  let captured: string | undefined;
  let writes: Promise<void> = Promise.resolve();
  const onSessionId = (sessionId: string): void => {
    captured = sessionId;
    registered?.noteSessionId(sessionId);
    writes = writes.then(() =>
      persistSessionIdBestEffort(input.eventBus, input.providerName, input.session.signalsFile, sessionId)
    );
  };
  return {
    onChunk: () => {
      const sessionId = input.getSessionId();
      if (sessionId !== undefined && sessionId !== captured) onSessionId(sessionId);
    },
    settled: async () => {
      await writes;
      return captured;
    },
  };
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
  (
    input: ProviderAttemptInput,
    sessionId: string | undefined,
    code: number | null,
    startedAtMs: number,
    alreadyPersisted: boolean
  ) =>
  async (): Promise<AttemptOutcome> => {
    let usage: ProviderUsage = { durationMs: Date.now() - startedAtMs };
    if (sessionId !== undefined) {
      emitSessionIdCaptured(input.eventBus, input.providerName, sessionId);
      const reported = input.emitProviderTokenUsage(sessionId);
      usage = {
        ...usage,
        ...(reported.inputTokens !== undefined ? { inputTokens: reported.inputTokens } : {}),
        ...(reported.outputTokens !== undefined ? { outputTokens: reported.outputTokens } : {}),
        ...(reported.cacheReadTokens !== undefined ? { cacheReadInputTokens: reported.cacheReadTokens } : {}),
        ...(reported.cacheCreationTokens !== undefined
          ? { cacheCreationInputTokens: reported.cacheCreationTokens }
          : {}),
      };
    }
    if (!alreadyPersisted) {
      await persistSessionIdBestEffort(input.eventBus, input.providerName, input.session.signalsFile, sessionId);
    }
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
  const { spawnFn, command, args, session, providerName } = input;
  // Nothing to kill yet: spawning under an already-aborted signal would leave a child no cancel can reach.
  if (session.abortSignal?.aborted === true) {
    return {
      kind: 'error',
      error: new AbortError({ elementName: providerName, reason: `${providerName}: aborted by caller` }),
    };
  }

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
      detached: true,
    });
  } catch (cause) {
    return classifySpawnFailure(providerName, cause as NodeJS.ErrnoException, argvBytes);
  }
  const registered = registerChild(input, child);
  try {
    return await superviseAttempt(input, child, argvBytes, startedAtMs, registered);
  } finally {
    registered?.release();
  }
};

const superviseAttempt = async (
  input: ProviderAttemptInput,
  child: ChildProcessWithoutNullStreams,
  argvBytes: number,
  startedAtMs: number,
  registered: RegisteredChildHandle | undefined
): Promise<AttemptOutcome> => {
  const { session, resolveOn, rateLimitRe, providerName, providerSlug, eventBus } = input;

  const stderrTail = createBoundedTail(STDERR_TAIL_CAP);
  const watchdogBannerId = `watchdog-${providerSlug}-${String(child.pid ?? 'unknown')}`;
  const idle = createIdleTelemetry(input, watchdogBannerId);
  const sessionIdCapture = createSessionIdCapture(input, registered);

  const { code, signal, spawnError } = await runHeadlessSpawn({
    child,
    onStdout: (chunk) => {
      input.onStdoutChunk(chunk);
      sessionIdCapture.onChunk();
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
  // Ids only reported on the final record (grok's `end`) are caught here, after the flush.
  sessionIdCapture.onChunk();
  const eagerSessionId = await sessionIdCapture.settled();

  const sessionId = input.getSessionId();
  const stdoutTail = input.getStdoutTail();
  const processErrorText = input.getProcessErrorText?.();
  return classifySpawnExit({
    session,
    // `spawnError` was previously dropped here, which left the classifier's spawn-error branch
    // unreachable from this path — a missing binary read as a plain non-zero exit.
    exit: { code, signal, argvBytes, ...(spawnError !== undefined ? { spawnError } : {}) },
    stderr: stderrTail.value(),
    rateLimitRe,
    ...(stdoutTail !== undefined && stdoutTail.length > 0 ? { stdoutTail } : {}),
    ...(processErrorText !== undefined && processErrorText.length > 0 ? { processErrorText } : {}),
    ...(sessionId !== undefined ? { capturedSessionId: sessionId } : {}),
    providerName,
    eventBus,
    watchdogBannerId,
    // Only meaningful on a crash branch; the classifier ignores it everywhere else.
    ...(idle.killedByWatchdog() ? { watchdogKilled: true } : {}),
    onSuccess: createSuccessHandler(input, sessionId, code, startedAtMs, eagerSessionId === sessionId),
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

/** The per-provider identity and operational wiring every attempt shares, resolved once from deps. */
export type AttemptBase = Pick<
  ProviderAttemptInput,
  'spawnFn' | 'command' | 'providerName' | 'providerSlug' | 'eventBus' | 'idleMs' | 'childRegistry'
>;

export interface CreateHeadlessProviderInput {
  readonly providerSlug: ProviderSlug;
  readonly deps: HeadlessProviderDeps;
  /** Executable used when `deps.command` is absent. */
  readonly defaultCommand: string;
  readonly resumeStaleRe: RegExp;
  /**
   * Called once at the start of each `generate()` call with the resolved {@link AttemptBase}.
   * Creates per-generate state (e.g. codex's output tempfile path) and returns the per-attempt
   * function and optional cleanup. The attempt function is called once per retry; cleanup runs
   * once after all attempts.
   */
  readonly createGenerateContext: (base: AttemptBase) => GenerateContext;
}

/**
 * Factory for the identical deps-resolution and generate()->runWithRateLimitRetry boilerplate
 * shared by all five headless provider adapters. Owning the {@link AttemptBase} here means no
 * adapter can forget a seam (e.g. `childRegistry`, which would silently disable orphan reaping).
 */
export const createHeadlessProvider = ({
  providerSlug,
  deps,
  defaultCommand,
  resumeStaleRe,
  createGenerateContext,
}: CreateHeadlessProviderInput): HeadlessAiProvider => {
  const providerName: ProviderName = `${providerSlug}-provider`;
  const base: AttemptBase = {
    spawnFn: deps.spawn ?? defaultProviderSpawn,
    command: deps.command ?? defaultCommand,
    providerName,
    providerSlug,
    eventBus: deps.eventBus,
    ...(deps.idleMs !== undefined ? { idleMs: deps.idleMs } : {}),
    ...(deps.childRegistry !== undefined ? { childRegistry: deps.childRegistry } : {}),
  };
  return {
    async generate(session) {
      const ctx = createGenerateContext(base);
      try {
        return await runWithRateLimitRetry({
          session,
          rateLimitRetries: deps.rateLimitRetries,
          ...(deps.backoffSchedule !== undefined ? { backoffSchedule: deps.backoffSchedule } : {}),
          eventBus: deps.eventBus,
          providerSlug,
          providerName,
          resumeStaleRe,
          attempt: ctx.attempt,
        });
      } finally {
        await ctx.cleanup?.();
      }
    },
  };
};
