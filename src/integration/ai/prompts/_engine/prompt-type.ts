/**
 * Branded string for an AI prompt that has been fully rendered: every `{{KEY}}` placeholder
 * substituted, no leftovers.
 *
 * The brand is created in `integration/ai/prompt/substitute.ts` after `assertFullySubstituted`
 * passes. Domain references the type so `HeadlessAiProvider.generate(input)` can accept only validated
 * prompts at the type level — a plain string cannot reach a provider.
 *
 * Pure type, no runtime — keeping it in `domain/` does not pull integration code into the
 * domain layer.
 */
declare const __prompt: unique symbol;
export type Prompt = string & { readonly [__prompt]: 'Prompt' };
