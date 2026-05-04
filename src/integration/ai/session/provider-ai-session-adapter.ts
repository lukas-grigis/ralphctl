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
 *
 * **session.md emission.** When a caller passes `options.sessionMdPath`
 * the adapter brackets every spawn (headless / interactive / resume /
 * each retry attempt) with `writeSessionStart` (before) +
 * `writeSessionFinish` (after). The file captures provider, model,
 * cwd, the actual flag list handed to the provider binary, the prompt
 * body, and the spawn outcome (sessionId + exitCode) so the user can
 * audit "where Claude was started, why, and with what permissions"
 * without reading code. Writes are best-effort: a write failure logs
 * a warn through the injected `LoggerPort` and the spawn proceeds
 * unchanged. For execution rounds the chain leaf rotates through
 * `session-1.md`, `session-2.md`, …  via {@link nextSessionPath}; for
 * single-shot AI rounds (refine / plan / ideate / feedback / evaluate)
 * a single `session.md` per unit folder is overwritten on re-run.
 */
import { RateLimitError } from '@src/domain/errors/rate-limit-error.ts';
import { StorageError } from '@src/domain/errors/storage-error.ts';
import { Result } from '@src/domain/result.ts';
import type { DomainError } from '@src/domain/errors/domain-error.ts';
import type { AiProvider, AiSessionPort, SessionOptions, SessionResult } from '@src/business/ports/ai-session-port.ts';
import type { LoggerPort } from '@src/business/ports/logger-port.ts';
import { getAdapter } from '@src/integration/ai/providers/registry.ts';
import type { ProviderAdapter } from '@src/integration/ai/providers/types.ts';
import { writeSessionFinish, writeSessionStart } from '@src/integration/persistence/session-md-writer.ts';
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
  /**
   * Logger used to surface session.md write failures (best-effort).
   * Optional so tests that don't exercise the audit path can omit it; the
   * production composition root always wires a real logger.
   */
  readonly logger?: LoggerPort;
}

/** Spawn mode for {@link writeSessionMdStart} so we can render the right flag list. */
type SpawnMode = 'headless' | 'interactive';

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
    await this.writeSessionMdStart(prompt, options, 'interactive');
    const runner = this.runner();
    const result = await runner.runInteractive({
      prompt,
      cwd: options.cwd,
      extraArgs: options.args,
      abortSignal: options.abortSignal,
      env: options.env ? { ...options.env } : undefined,
    });
    await this.writeSessionMdFinishVoid(options, result);
    return result;
  }

  async spawnHeadless(prompt: string, options: SessionOptions): Promise<Result<SessionResult, DomainError>> {
    await this.ensureReady();
    await this.writeSessionMdStart(prompt, options, 'headless');
    const result = await this.runner().runHeadless({
      prompt,
      cwd: options.cwd,
      extraArgs: options.args,
      resumeSessionId: options.resumeSessionId,
      abortSignal: options.abortSignal,
      env: options.env ? { ...options.env } : undefined,
    });
    await this.writeSessionMdFinishHeadless(options, result);
    return result;
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

  // ── session.md audit hooks ───────────────────────────────────────────

  /**
   * Write the spawn-start half of `session.md`. Idempotent on the
   * absence of `sessionMdPath` (no-op). Writes are best-effort: any
   * filesystem failure logs a warn and is otherwise swallowed so the
   * spawn proceeds — auditing is observability, not a precondition.
   *
   * The flag list rendered into the file is the EXACT arg list the
   * provider binary will receive (sans interactive prompt — which is
   * already captured separately under `## Prompt`). Resume args are
   * appended for headless sessions when `resumeSessionId` is set so the
   * audit trail records the `--resume <id>` (or equivalent) the runner
   * will use.
   */
  private async writeSessionMdStart(prompt: string, options: SessionOptions, mode: SpawnMode): Promise<void> {
    const path = options.sessionMdPath;
    if (path === undefined) return;
    const adapter = this.adapter;
    if (adapter === null) return;
    const flags = this.buildAuditFlags(adapter, options, mode);
    const result = await writeSessionStart({
      path: String(path),
      provider: adapter.name,
      cwd: String(options.cwd),
      flags,
      ...(options.resumeSessionId !== undefined && options.resumeSessionId.length > 0
        ? { sessionId: options.resumeSessionId }
        : {}),
      started: new Date().toISOString(),
      promptBody: prompt,
    });
    if (!result.ok) {
      this.opts.logger?.warn('failed to write session.md (start) — proceeding with spawn', {
        path: String(path),
        error: result.error.message,
      });
    }
  }

  /**
   * Write the spawn-finish half of `session.md` for a headless spawn.
   * Captures `model` + `sessionId` from the `SessionResult` on success,
   * `exitCode: 1` on a structural failure (`StorageError`/`RateLimitError`).
   * The actual provider exit code isn't surfaced through the runner's
   * typed Result — `1` is a faithful "spawn failed" stand-in for audit
   * purposes; the underlying error's message is already in the logs.
   */
  private async writeSessionMdFinishHeadless(
    options: SessionOptions,
    result: Result<SessionResult, DomainError>
  ): Promise<void> {
    const path = options.sessionMdPath;
    if (path === undefined) return;
    const sessionId = result.ok ? result.value.sessionId : undefined;
    const written = await writeSessionFinish({
      path: String(path),
      finished: new Date().toISOString(),
      exitCode: result.ok ? 0 : 1,
      ...(sessionId !== undefined ? { sessionId } : {}),
    });
    if (!written.ok) {
      this.opts.logger?.warn('failed to write session.md (finish) — spawn already settled', {
        path: String(path),
        error: written.error.message,
      });
      return;
    }
    // Append model when surfaced (writeSessionFinish only carries the
    // standard finish fields; model lives in the start frontmatter for
    // pre-spawn sessions, but a successful headless run is the first
    // chance we have to learn the resolved model identifier — patch it
    // in by re-rendering with the merged field set).
    if (result.ok && result.value.model !== undefined) {
      await this.patchSessionMdModel(String(path), result.value.model);
    }
  }

  /**
   * Write the spawn-finish half of `session.md` for an interactive
   * spawn. Interactive sessions surface no `SessionResult` (the user
   * drove the terminal directly), so we record exitCode only.
   */
  private async writeSessionMdFinishVoid(options: SessionOptions, result: Result<void, DomainError>): Promise<void> {
    const path = options.sessionMdPath;
    if (path === undefined) return;
    const written = await writeSessionFinish({
      path: String(path),
      finished: new Date().toISOString(),
      exitCode: result.ok ? 0 : 1,
    });
    if (!written.ok) {
      this.opts.logger?.warn('failed to write session.md (finish) — spawn already settled', {
        path: String(path),
        error: written.error.message,
      });
    }
  }

  /**
   * Patch the resolved `model` into an existing `session.md`. Reuses
   * `writeSessionFinish` to round-trip frontmatter without touching the
   * prompt body. Best-effort — write failures log a warn.
   *
   * Implementation note: `writeSessionFinish` was scoped to the
   * standard finish fields only. The narrow `model` patch here goes
   * through `writeSessionStart` would clobber the body, so we re-read,
   * splice the field, and re-emit via the same writer surface. This
   * keeps the YAML-handling logic in one place (`session-md-writer`)
   * even at the cost of a second IO round-trip — the audit pack is
   * cold-path and we'd rather centralise format knowledge.
   */
  private async patchSessionMdModel(path: string, model: string): Promise<void> {
    try {
      const fs = await import('node:fs/promises');
      const existing = await fs.readFile(path, 'utf-8');
      // Surgical: rewrite the first `---`-delimited frontmatter block
      // with `model:` either inserted (if missing) or replaced. Done
      // inline because `session-md-writer` keeps its parser private —
      // reaching for it here would expand the public surface for one
      // post-hoc patch.
      const patched = upsertFrontmatterField(existing, 'model', model);
      if (patched === existing) return;
      await fs.writeFile(path, patched, { encoding: 'utf-8', mode: 0o600 });
    } catch (err) {
      this.opts.logger?.warn('failed to patch session.md model field', {
        path,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Build the flag list audited into session.md. Headless: the runner
   * appends `--resume <id>` when `resumeSessionId` is set, so we mirror
   * that here for fidelity. Interactive: skip the prompt slot — the
   * prompt body is captured separately under `## Prompt`, and provider
   * adapters embed it as a positional arg (Claude appends `-- <prompt>`,
   * Copilot puts it last). Trimming the trailing prompt keeps the
   * flag list scannable.
   */
  private buildAuditFlags(adapter: ProviderAdapter, options: SessionOptions, mode: SpawnMode): readonly string[] {
    const extras = options.args ?? [];
    if (mode === 'headless') {
      const flags = [...adapter.buildHeadlessArgs(extras)];
      if (options.resumeSessionId !== undefined && options.resumeSessionId.length > 0) {
        try {
          flags.push(...adapter.buildResumeArgs(options.resumeSessionId));
        } catch {
          // Invalid resume id will surface to the user via the actual
          // spawn failure; the audit just records the flags we know
          // about.
        }
      }
      return flags;
    }
    // Interactive — render the args without the prompt positional.
    const built = adapter.buildInteractiveArgs('', extras);
    return stripTrailingPromptSlot(built);
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

/**
 * Drop the trailing prompt arg (and a preceding `--` separator if one
 * is present) from an interactive arg list so audit logs don't show an
 * empty positional slot. Both Claude and Copilot put the prompt last;
 * Claude prefixes it with `--` to terminate option parsing.
 */
function stripTrailingPromptSlot(args: readonly string[]): readonly string[] {
  let end = args.length;
  // Drop the empty positional we passed in.
  if (end > 0 && args[end - 1] === '') end -= 1;
  // Drop a trailing `--` separator if it's now exposed.
  if (end > 0 && args[end - 1] === '--') end -= 1;
  return args.slice(0, end);
}

/**
 * Upsert a single key into a YAML-ish frontmatter block. The block is
 * the first `---`-delimited section at the top of the file. If `key`
 * already appears, its value is replaced; otherwise the new line is
 * inserted just before the closing `---`. Handles only flat string
 * values — sufficient for the `model` patch the adapter performs.
 */
function upsertFrontmatterField(content: string, key: string, value: string): string {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') return content;
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]?.trim() === '---') {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx < 0) return content;
  const keyRegex = new RegExp(`^${key}\\s*:`);
  for (let i = 1; i < closeIdx; i += 1) {
    const line = lines[i] ?? '';
    if (keyRegex.test(line.trim())) {
      lines[i] = `${key}: ${value}`;
      return lines.join('\n');
    }
  }
  lines.splice(closeIdx, 0, `${key}: ${value}`);
  return lines.join('\n');
}
