import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type { RateLimitError } from '@src/domain/value/error/rate-limit-error.ts';
import type { ProviderOutput } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';

/**
 * The internal outcome shape every provider's `spawnAttempt` returns. The outer
 * `generate(session)` translates these into `Result<ProviderOutput, DomainError>` and
 * decides whether to retry on `rate-limit`.
 *
 * Shared across claude/codex/copilot to avoid per-provider duplication of an identical type
 * and to let `classifySpawnExit` (in this same `_engine/` directory) return one canonical
 * shape that every adapter consumes verbatim.
 */
export type AttemptOutcome =
  | { readonly kind: 'success'; readonly output: ProviderOutput }
  | { readonly kind: 'rate-limit'; readonly error: RateLimitError }
  | { readonly kind: 'error'; readonly error: DomainError };
