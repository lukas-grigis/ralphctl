import type { ModelAvailabilityProbe } from '@src/integration/ai/providers/_engine/model-availability-probe.ts';

/**
 * Claude model-availability probe — passthrough. The Claude Code CLI exposes no headless,
 * account-scoped model list, so every catalog model is treated as available. Returns the catalog
 * reference unchanged (fail open by construction).
 *
 * @public
 */
export const claudeModelAvailabilityProbe: ModelAvailabilityProbe = {
  async availableModels(catalog: readonly string[]): Promise<readonly string[]> {
    return catalog;
  },
};
