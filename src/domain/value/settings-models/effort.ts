/**
 * Per-provider effort vocabularies — the editable values each provider's CLI accepts on its
 * effort / reasoning-depth flag. Shared between the Settings view and the per-launch customize
 * picker so the two surfaces always offer the same option list without diverging copies.
 *
 * Domain-owned: the per-provider effort schemas in `domain/entity/settings.ts` are built from
 * these tuples, so the parser and every UI surface read the same list rather than re-declaring
 * the literals.
 *
 * The Codex list is the provider-level superset — `minimal` was retired by codex ≥ 0.145
 * (persisted rows are migrated to `low`); `max` exists only on the 5.6 and GPT-6 families and
 * `ultra` only on gpt-6-astra / gpt-6-sol / gpt-5.6-sol / gpt-5.6-terra (plan-gated to Plus+,
 * never on the luna tiers) — per-model narrowing is deliberately left to the codex CLI at spawn,
 * matching the custom-model policy.
 *
 * @public
 */

import type { AiProvider } from '@src/domain/entity/settings.ts';
import { CODEX_MODEL_EFFORT_LEVELS, isCodexModel } from '@src/domain/value/settings-models/codex.ts';
import { COPILOT_MODEL_EFFORT_LEVELS, isCopilotModel } from '@src/domain/value/settings-models/copilot.ts';

export const PROVIDER_EFFORT_LEVELS = {
  'claude-code': ['low', 'medium', 'high', 'xhigh', 'max'],
  'github-copilot': ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
  'openai-codex': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  // OpenCode forwards effort to `--variant`, whose accepted values come from the upstream
  // provider behind the selected `provider/model` id — so this is a permissive superset and the
  // CLI narrows per model at spawn, same posture as the codex row above.
  opencode: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  'xai-grok': ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
} as const satisfies Record<AiProvider, readonly [string, ...string[]]>;

/**
 * Effort levels one catalog model accepts, or `undefined` when unknown (custom id, or a provider
 * with no per-model table) — the caller then leaves the provider CLI to arbitrate. `[]` means the
 * model has no effort dimension at all.
 */
export const modelEffortLevels = (provider: AiProvider, model: string): readonly string[] | undefined => {
  if (provider === 'github-copilot') return isCopilotModel(model) ? COPILOT_MODEL_EFFORT_LEVELS[model] : undefined;
  if (provider === 'openai-codex') return isCodexModel(model) ? CODEX_MODEL_EFFORT_LEVELS[model] : undefined;
  return undefined;
};
