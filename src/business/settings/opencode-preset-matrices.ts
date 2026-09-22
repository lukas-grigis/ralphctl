import type { AiSettings } from '@src/domain/entity/settings.ts';
import { OPENCODE, OPENCODE_BIG, OPENCODE_MINI } from '@src/business/settings/preset-model-ids.ts';

/**
 * OpenCode's zero-auth free tier. This provider has exactly one preset: every free-tier model
 * sits at the same (zero) price point, so an economic or frontier variant would differ in name
 * only. An operator who authenticates an upstream provider through `opencode providers` should
 * pin rows directly.
 *
 * Effort is left unset on every row. OpenCode forwards it to `--variant`, whose accepted
 * values come from the upstream provider, and the free-tier models generally expose none.
 */
export const OPENCODE_ONLY: AiSettings = {
  refine: { provider: OPENCODE, model: OPENCODE_MINI },
  plan: { provider: OPENCODE, model: OPENCODE_BIG },
  implement: {
    generator: { provider: OPENCODE, model: OPENCODE_BIG },
    evaluator: { provider: OPENCODE, model: OPENCODE_BIG },
  },
  readiness: { provider: OPENCODE, model: OPENCODE_MINI },
  ideate: { provider: OPENCODE, model: OPENCODE_BIG },
  createPr: { provider: OPENCODE, model: OPENCODE_MINI },
};
