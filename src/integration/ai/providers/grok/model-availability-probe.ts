import type { ModelAvailabilityProbe } from '@src/integration/ai/providers/_engine/model-availability-probe.ts';

/**
 * Grok model-availability probe — passthrough. Returns the catalog reference unchanged
 * (fail open by construction). The grok CLI exposes `grok models` but no cheap non-interactive
 * per-account filter; the static catalog is the picker source until one exists.
 *
 * @public
 */
export const grokModelAvailabilityProbe: ModelAvailabilityProbe = {
  async availableModels(catalog: readonly string[]): Promise<readonly string[]> {
    return catalog;
  },
};
