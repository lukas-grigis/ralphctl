/**
 * `ProviderAiSessionAdapter` — the only {@link AiSessionPort}
 * implementation. Bridges between the abstract port the business layer
 * sees and the concrete provider {@link ProviderAdapter} +
 * {@link SessionRunner} pair under it.
 *
 * Provider resolution is deliberately lazy: the adapter accepts a
 * `getProvider` callback (resolved from config) and caches the resulting
 * {@link ProviderAdapter} the first time {@link ensureReady} runs.
 * Subsequent calls are no-ops. The synchronous getters
 * (`getProviderName`, `getProviderDisplayName`, `getSpawnEnv`) require
 * `ensureReady` to have completed — calling them earlier is a programmer
 * error and throws synchronously.
 *
 * The retry loop in {@link spawnWithRetry} is intentionally tiny: one
 * additional attempt by default after a {@link RateLimitError}, sleeping
 * for the upstream-supplied `retryAfterMs` (or 60s when missing). Cross-
 * process coordination during a 429 storm is the kernel
 * `RateLimitCoordinator`'s job — this adapter only handles the
 * single-spawn recovery.
 */
import { RateLimitError } from '../../../domain/errors/rate-limit-error.ts';
import { StorageError } from '../../../domain/errors/storage-error.ts';
import { Result } from '../../../domain/result.ts';
import type { DomainError } from '../../../domain/errors/domain-error.ts';
import type {
  AiProvider,
  AiSessionPort,
  SessionOptions,
  SessionResult,
} from '../../../business/ports/ai-session-port.ts';
import { getAdapter } from '../providers/registry.ts';
import type { ProviderAdapter } from '../providers/types.ts';
import type { ProcessRunner } from './process-runner.ts';
import { SessionRunner } from './session-runner.ts';

/** Default retry-after when the upstream doesn't surface one. */
const DEFAULT_RETRY_AFTER_MS = 60_000;
/** Default retry budget for `spawnWithRetry`. */
const DEFAULT_MAX_RETRIES = 1;

/**
 * Lifecycle callback fired by {@link ProviderAiSessionAdapter.spawnWithRetry}
 * around its rate-limit recovery sleep. The composition root wires this to
 * `SignalBusPort` so the live execution dashboard can render a countdown
 * while the adapter waits.
 */
export interface RateLimitListenerCallbacks {
  onPaused(reason: string, resumeAt?: Date): void;
  onResumed(): void;
}

export interface ProviderAiSessionAdapterOptions {
  /**
   * Resolve the active provider lazily. Called at most once (cached).
   * Accepts either a literal {@link AiProvider} or a fully-built
   * {@link ProviderAdapter} (the latter is mainly a test seam).
   */
  readonly getProvider: () => Promise<AiProvider | ProviderAdapter>;
  readonly process: ProcessRunner;
  /** Sleep helper — overridable so tests don't burn real time. */
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * Optional rate-limit lifecycle callback. When set, fires `onPaused`
   * before the inter-attempt sleep and `onResumed` once the sleep completes
   * (or when the retry budget is exhausted). Composition root wires this to
   * `SignalBusPort`; tests inject spies.
   */
  readonly rateLimitListener?: RateLimitListenerCallbacks;
}

export class ProviderAiSessionAdapter implements AiSessionPort {
  private readonly opts: ProviderAiSessionAdapterOptions;
  private adapter: ProviderAdapter | null = null;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: ProviderAiSessionAdapterOptions) {
    this.opts = opts;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  async ensureReady(): Promise<void> {
    if (this.adapter) return;
    const resolved = await this.opts.getProvider();
    this.adapter = isProviderAdapter(resolved) ? resolved : getAdapter(resolved);
  }

  getProviderName(): AiProvider {
    return this.requireAdapter().name;
  }

  getProviderDisplayName(): string {
    return this.requireAdapter().displayName;
  }

  getSpawnEnv(): Record<string, string> {
    return this.requireAdapter().getSpawnEnv();
  }

  async spawnInteractive(prompt: string, options: SessionOptions): Promise<Result<void, DomainError>> {
    await this.ensureReady();
    const runner = this.runner();
    const result = await runner.runInteractive({
      prompt,
      cwd: options.cwd,
      extraArgs: options.args,
      abortSignal: options.abortSignal,
      env: options.env ? { ...options.env } : undefined,
    });
    return result;
  }

  async spawnHeadless(prompt: string, options: SessionOptions): Promise<Result<SessionResult, DomainError>> {
    await this.ensureReady();
    return this.runner().runHeadless({
      prompt,
      cwd: options.cwd,
      extraArgs: options.args,
      resumeSessionId: options.resumeSessionId,
      abortSignal: options.abortSignal,
      env: options.env ? { ...options.env } : undefined,
    });
  }

  async resumeSession(
    sessionId: string,
    prompt: string,
    options: SessionOptions
  ): Promise<Result<SessionResult, DomainError>> {
    return this.spawnHeadless(prompt, { ...options, resumeSessionId: sessionId });
  }

  async spawnWithRetry(
    prompt: string,
    options: SessionOptions & { readonly maxRetries?: number }
  ): Promise<Result<SessionResult, DomainError>> {
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    let resumeSessionId = options.resumeSessionId;
    let lastError: RateLimitError | StorageError | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // Bail early if the caller cancelled while we were sleeping.
      if (options.abortSignal?.aborted) {
        return Result.error(
          new StorageError({
            subCode: 'io',
            message: 'aborted by caller',
          })
        );
      }

      const r = await this.spawnHeadless(prompt, { ...options, resumeSessionId });
      if (r.ok) return r;

      const err = r.error;
      // Only retry on RateLimitError. Any other failure is terminal.
      if (!(err instanceof RateLimitError)) {
        return r;
      }
      lastError = err;
      if (err.sessionId !== undefined) {
        resumeSessionId = err.sessionId;
      }
      if (attempt >= maxRetries) {
        return r;
      }
      const sleepMs = err.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS;
      const listener = this.opts.rateLimitListener;
      if (listener) {
        const resumeAt = new Date(Date.now() + sleepMs);
        listener.onPaused(err.message, resumeAt);
      }
      try {
        await this.sleep(sleepMs);
      } finally {
        listener?.onResumed();
      }
    }

    // Defensive — the loop body always returns above.
    /* istanbul ignore next */
    return Result.error(
      lastError ??
        new StorageError({
          subCode: 'io',
          message: 'spawnWithRetry exhausted retries',
        })
    );
  }

  private runner(): SessionRunner {
    return new SessionRunner(this.requireAdapter(), this.opts.process);
  }

  private requireAdapter(): ProviderAdapter {
    if (!this.adapter) {
      throw new Error('ProviderAiSessionAdapter not ready — call ensureReady() before sync getters');
    }
    return this.adapter;
  }
}

function isProviderAdapter(value: AiProvider | ProviderAdapter): value is ProviderAdapter {
  return typeof value !== 'string';
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
