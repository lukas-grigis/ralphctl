import type { Result } from '@src/domain/result.ts';
import type { AiProvider } from '@src/domain/entity/settings.ts';
import type { HeadlessAiProvider, ProviderUsage } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import { STDERR_TAIL_CAP, createBoundedTail } from '@src/integration/ai/providers/_engine/bounded-tail.ts';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { type ProviderSpawn, defaultProviderSpawn } from '@src/integration/ai/providers/_engine/spawn.ts';
import type { HeadlessProviderDeps } from '@src/integration/ai/providers/_engine/headless-provider-deps.ts';
import { runHeadlessSpawn } from '@src/integration/ai/providers/_engine/run-headless-spawn.ts';
import { runWithRateLimitRetry } from '@src/integration/ai/providers/_engine/run-with-rate-limit-retry.ts';
import { writeTextAtomic } from '@src/integration/io/fs.ts';
import { persistSessionIdBestEffort } from '@src/integration/ai/providers/_engine/persist-session-id.ts';
import { contextWindowFor } from '@src/domain/value/settings-models/context-window.ts';
import { type AttemptOutcome, abortedByCaller } from '@src/integration/ai/providers/_engine/attempt-outcome.ts';
import { PROVIDER_TRAITS } from '@src/integration/ai/providers/_engine/provider-traits.ts';
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

/**
 * Token usage an adapter captured from its CLI stream. Field names match `TokenUsageEvent`, so the
 * payload spreads straight into the event; each provider fills only the subset its stream reports.
 */
export interface ProviderTokenUsage {
  readonly model?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheCreationTokens?: number;
  readonly liveInputTokens?: number;
  readonly liveCacheReadTokens?: number;
  readonly liveCacheCreationTokens?: number;
}

const emitSessionIdCaptured = (eventBus: EventBus, providerName: string, sessionId: string): void => {
  eventBus.publish({
    type: 'log',
    level: 'debug',
    message: `${providerName}: session id captured`,
    meta: { sessionId },
    at: IsoTimestamp.now(),
  });
};

const emitTokenUsage = (
  eventBus: EventBus,
  session: AiSession,
  sessionId: string,
  provider: AiProvider,
  usage: ProviderTokenUsage
): void => {
  const window = contextWindowFor(usage.model);
  const chainSessionId = session.chainSessionId;
  eventBus.publish({
    type: 'token-usage',
    sessionId,
    ...(chainSessionId !== undefined ? { chainSessionId } : {}),
    provider,
    ...usage,
    ...(window !== undefined ? { contextWindow: window } : {}),
    ...(session.role !== undefined ? { role: session.role } : {}),
    at: IsoTimestamp.now(),
  });
};

/**
 * Per-attempt spawn configuration: the adapter supplies argv and its stream accessors; the scaffold
 * owns the child lifecycle, stderr tail, watchdog, session-id persistence and exit classification.
 */
export interface ProviderAttemptInput {
  readonly spawnFn: ProviderSpawn;
  readonly command: string;
  readonly args: readonly string[];
  readonly session: AiSession;
  /** Variables overlaid on the inherited environment for this spawn. */
  readonly env?: Readonly<Record<string, string>>;
  /** Prompt piped to stdin. Absent (copilot, grok pass a prompt file): stdin is closed at once. */
  readonly stdin?: string;
  readonly rateLimitRe: RegExp;
  readonly onStdoutChunk: (chunk: string) => void;
  /** Drain a trailing partial line after the child closes, so no record is lost to a missing newline. */
  readonly flush: () => void;
  readonly getSessionId: () => string | undefined;
  /** Assistant stdout tail for the narrow rate-limit tier, or undefined to scan stderr only. */
  readonly getStdoutTail: () => string | undefined;
  /** The CLI's structured stdout error record, for CLIs whose fatal errors leave stderr empty. */
  readonly getProcessErrorText?: () => string | undefined;
  /**
   * Body mirrored to `session.bodyFile`. Best-effort: resolve an unreadable body to `''` rather
   * than an error, which would discard an otherwise-recovered success.
   */
  readonly getBody: () => Promise<Result<string, DomainError>>;
  /** Token usage captured from the stream. Read on success only, and only once a session id was captured. */
  readonly getUsage: () => ProviderTokenUsage;
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

/** Idle-watchdog wiring for one attempt: the spawn option, the `onIdle` warn + banner, and whether it fired. */
const createIdleTelemetry = (
  input: ProviderAttemptInput,
  watchdogBannerId: string
): {
  readonly spawnOption: { readonly idleMs?: number };
  readonly onIdle: () => void;
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
 * The success block `classifySpawnExit` runs on a clean exit AND on signals-recovery. The returned
 * {@link ProviderUsage} carries wall-clock and token counts so the chain can persist per-attempt cost.
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
      // The event is ephemeral; the same counts ride `ProviderOutput.usage` so the chain can persist them.
      const reported = input.getUsage();
      emitTokenUsage(input.eventBus, input.session, sessionId, PROVIDER_BY_SLUG[input.providerSlug], reported);
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
  if (session.abortSignal?.aborted === true) return { kind: 'error', error: abortedByCaller(providerName) };

  const argvBytes = argvByteLength(command, args);
  const startedAtMs = Date.now();
  (input.childRegistry ?? NOOP_CHILD_REGISTRY).beforeSpawn();

  // `crossPlatformSpawn` throws synchronously for an oversized Windows argv; uncaught it would kill the process.
  let child;
  try {
    child = spawnFn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'] as const,
      // The CLIs discover CLAUDE.md / AGENTS.md, skills and MCP config from the child's cwd.
      cwd: String(session.cwd),
      detached: true,
      ...(input.env !== undefined ? { env: { ...process.env, ...input.env } } : {}),
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
  const { session, rateLimitRe, providerName, providerSlug, eventBus } = input;

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

/** Per-`generate()` state: `attempt` runs once per retry, `cleanup` once after the last attempt. */
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
  readonly resumeStaleRe: RegExp;
  readonly createGenerateContext: (base: AttemptBase) => GenerateContext;
}

/**
 * Resolves the {@link AttemptBase} once and runs `generate()` through the shared retry loop, so no
 * adapter can forget a seam (a missing `childRegistry` would silently disable orphan reaping).
 */
export const createHeadlessProvider = ({
  providerSlug,
  deps,
  resumeStaleRe,
  createGenerateContext,
}: CreateHeadlessProviderInput): HeadlessAiProvider => {
  const providerName: ProviderName = `${providerSlug}-provider`;
  const base: AttemptBase = {
    spawnFn: deps.spawn ?? defaultProviderSpawn,
    command: deps.command ?? PROVIDER_TRAITS[PROVIDER_BY_SLUG[providerSlug]].binary,
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
