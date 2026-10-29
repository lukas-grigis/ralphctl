import { AbortError } from '@src/domain/value/error/abort-error.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type { RateLimitError } from '@src/domain/value/error/rate-limit-error.ts';
import type { ProviderOutput } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';

/** What one spawn attempt resolves to; the retry loop maps it onto `Result<ProviderOutput, DomainError>`. */
export type AttemptOutcome =
  | { readonly kind: 'success'; readonly output: ProviderOutput }
  | { readonly kind: 'rate-limit'; readonly error: RateLimitError }
  | { readonly kind: 'error'; readonly error: DomainError };

/**
 * A caller cancel. It must surface as `AbortError` — the one error chains propagate transparently —
 * never as a failure shape a downstream guard could catch and continue past.
 */
export const abortedByCaller = (providerName: string, context = ''): AbortError =>
  new AbortError({ elementName: providerName, reason: `${providerName}: aborted by caller${context}` });
