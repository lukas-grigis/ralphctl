/**
 * Per-provider effort vocabularies — the editable values each provider's CLI accepts on its
 * effort / reasoning-depth flag. Shared between the Settings view and the per-launch customize
 * picker so the two surfaces always offer the same option list without diverging copies.
 *
 * Domain-owned: the schema in `domain/entity/settings.ts` validates persisted rows against
 * the same enums (Claude / Copilot / Codex variants); keeping the levels here lets every UI
 * surface read from the same array rather than re-declaring the literal list.
 *
 * The Codex list is the provider-level superset — `minimal` was retired by codex ≥ 0.145
 * (persisted rows are migrated to `low`); `max` exists only on the 5.6 family and `ultra` only
 * on sol/terra (plan-gated to Plus+) — per-model narrowing is deliberately left to the codex CLI
 * at spawn, matching the custom-model policy.
 *
 * @public
 */

import type { AiProvider } from '@src/domain/entity/settings.ts';

export const PROVIDER_EFFORT_LEVELS: Readonly<Record<AiProvider, readonly string[]>> = {
  'claude-code': ['low', 'medium', 'high', 'xhigh', 'max'],
  'github-copilot': ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
  'openai-codex': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  // OpenCode forwards effort to `--variant`, whose accepted values come from the upstream
  // provider behind the selected `provider/model` id — so this is a permissive superset and the
  // CLI narrows per model at spawn, same posture as the codex row above.
  opencode: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
};
