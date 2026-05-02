/**
 * `FakeAiSessionPort` — non-IO fake of {@link AiSessionPort} for use case
 * unit tests. Captures the last spawn invocation so tests can assert on
 * the prompt and options the use case built, and returns scripted output
 * (or scripted errors) to drive the use case down each path.
 *
 * Keep deliberately small — only the methods business code actually uses
 * (`spawnHeadless`, `ensureReady`, `getProviderDisplayName`) are
 * implemented in any meaningful way. Methods we don't call from tests are
 * stubbed enough to satisfy the interface.
 */
import type { StorageError } from '@src/domain/errors/storage-error.ts';
import { Result } from '@src/domain/result.ts';
import type { AiProvider, AiSessionPort, SessionOptions, SessionResult } from '@src/business/ports/ai-session-port.ts';

/** A scripted spawn outcome — an `ok` result or a synthetic failure. */
export type ScriptedSpawnOutcome =
  | { readonly kind: 'ok'; readonly result: SessionResult }
  | { readonly kind: 'error'; readonly error: StorageError };

/** Capture of a single `spawnHeadless` call. */
export interface CapturedSpawn {
  readonly prompt: string;
  readonly options: SessionOptions;
}

export interface FakeAiSessionPortOptions {
  /**
   * Sequence of outcomes to return — one per call. Defaults to a single
   * `{ kind: 'ok', result: { output: '' } }` outcome so a "do nothing"
   * test setup still typechecks.
   */
  readonly outcomes?: readonly ScriptedSpawnOutcome[];
  readonly providerName?: AiProvider;
  readonly displayName?: string;
}

export class FakeAiSessionPort implements AiSessionPort {
  /** Records every `spawnHeadless` call, in order. */
  readonly captured: CapturedSpawn[] = [];

  private readonly outcomes: ScriptedSpawnOutcome[];
  private readonly providerName: AiProvider;
  private readonly displayName: string;

  constructor(opts?: FakeAiSessionPortOptions) {
    this.outcomes =
      opts?.outcomes !== undefined && opts.outcomes.length > 0
        ? [...opts.outcomes]
        : [{ kind: 'ok', result: { output: '' } }];
    this.providerName = opts?.providerName ?? 'claude';
    this.displayName = opts?.displayName ?? 'Claude Code';
  }

  spawnHeadless(prompt: string, options: SessionOptions): Promise<Result<SessionResult, StorageError>> {
    this.captured.push({ prompt, options });
    const next = this.outcomes.shift();
    if (next === undefined) {
      // Fall back to an empty success when callers exhaust the script.
      return Promise.resolve(Result.ok<SessionResult>({ output: '' }));
    }
    if (next.kind === 'ok') return Promise.resolve(Result.ok(next.result));
    return Promise.resolve(Result.error(next.error));
  }

  spawnInteractive(): Promise<Result<void, StorageError>> {
    return Promise.resolve(Result.ok());
  }

  spawnWithRetry(prompt: string, options: SessionOptions): Promise<Result<SessionResult, StorageError>> {
    return this.spawnHeadless(prompt, options);
  }

  resumeSession(
    _sessionId: string,
    prompt: string,
    options: SessionOptions
  ): Promise<Result<SessionResult, StorageError>> {
    return this.spawnHeadless(prompt, options);
  }

  ensureReady(): Promise<void> {
    return Promise.resolve();
  }

  getProviderName(): AiProvider {
    return this.providerName;
  }

  getProviderDisplayName(): string {
    return this.displayName;
  }

  getSpawnEnv(): Record<string, string> {
    return {};
  }
}
