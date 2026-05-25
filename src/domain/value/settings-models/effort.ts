/**
 * Per-provider effort vocabularies — the editable values each provider's CLI accepts on its
 * effort / reasoning-depth flag. Shared between the Settings view and the per-launch customize
 * picker so the two surfaces always offer the same option list without diverging copies.
 *
 * Domain-owned: the schema in `domain/entity/settings.ts` validates persisted rows against
 * the same enums (Claude / Copilot / Codex variants); keeping the levels here lets every UI
 * surface read from the same array rather than re-declaring the literal list.
 *
 * @public
 */

import type { AiProvider } from '@src/domain/entity/settings.ts';

export const PROVIDER_EFFORT_LEVELS: Readonly<Record<AiProvider, readonly string[]>> = {
  'claude-code': ['low', 'medium', 'high', 'xhigh', 'max'],
  'github-copilot': ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
  'openai-codex': ['minimal', 'low', 'medium', 'high'],
};
