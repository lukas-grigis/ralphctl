import type { ProviderUsage } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import { positiveCountCarry } from '@src/application/flows/implement/leaves/_shared/nudge-count-carry.ts';

/**
 * Fold ONE role turn's raw cost telemetry into the per-attempt ctx totals `settle-attempt`
 * persists onto the settling attempt. Shared by the generator and evaluator leaves' ctx-merge
 * functions so both roles' spawns land in the same three counters.
 *
 * Each field rides {@link positiveCountCarry}, so a turn that reported nothing (or reported a
 * zero) contributes no key at all — the counters stay `undefined` rather than becoming a
 * fabricated `0`, which is what keeps "the provider reported no usage" distinguishable from
 * "the attempt genuinely cost nothing".
 */
export const attemptUsageCarry = (
  ctx: ImplementCtx,
  usage: ProviderUsage | undefined
): Partial<
  Pick<ImplementCtx, 'currentAttemptInputTokens' | 'currentAttemptOutputTokens' | 'currentAttemptDurationMs'>
> =>
  usage === undefined
    ? {}
    : {
        ...positiveCountCarry('currentAttemptInputTokens', usage.inputTokens ?? 0, ctx.currentAttemptInputTokens),
        ...positiveCountCarry('currentAttemptOutputTokens', usage.outputTokens ?? 0, ctx.currentAttemptOutputTokens),
        ...positiveCountCarry('currentAttemptDurationMs', usage.durationMs ?? 0, ctx.currentAttemptDurationMs),
      };
