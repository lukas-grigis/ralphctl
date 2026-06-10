import type { ModelAvailabilityProbe } from '@src/integration/ai/providers/_engine/model-availability-probe.ts';

/**
 * Copilot model-availability probe — passthrough for v1. Returns the catalog reference unchanged
 * (fail open by construction).
 *
 * TODO(copilot-probe v2): the real source is the Copilot models API
 * (`api.githubcopilot.com/models`), which returns the account's enabled models. We can't query it
 * headlessly yet because the Copilot CLI's OAuth token isn't cleanly resolvable outside the CLI's
 * own session — revisit once we have a headless token resolution path. Keeping this a passthrough
 * means the wiring is identical to the other providers and the upgrade is a one-file change.
 *
 * @public
 */
export const copilotModelAvailabilityProbe: ModelAvailabilityProbe = {
  async availableModels(catalog: readonly string[]): Promise<readonly string[]> {
    return catalog;
  },
};
