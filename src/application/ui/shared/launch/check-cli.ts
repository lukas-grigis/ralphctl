/**
 * Fail-fast PATH check used by every launcher that opens an AI session. Resolves the configured
 * provider for the flow's settings row, probes PATH for that provider's CLI binary, and returns
 * a `LaunchResult.fail` naming the missing binary, the flow, and the settings key when absent.
 * Returns `undefined` when the binary is present — the launcher then proceeds to construct the
 * chain element.
 *
 * Detection only runs at the three sites in scope (fresh-install, preset-apply, launch); the
 * per-row Settings editor never triggers a probe. Within a single launch call the launcher
 * invokes this helper exactly once — no internal caching is needed.
 */

import { detectInstalledProviders, PROVIDER_BINARY } from '@src/integration/system/detect-cli.ts';
import type { AiProvider, Settings } from '@src/domain/entity/settings.ts';
import type { FlowId } from '@src/domain/value/flow-id.ts';
import type { LaunchResult } from '@src/application/ui/shared/launcher.ts';

/**
 * Map a launcher flow id to the AI {@link FlowId} that owns its session — same mapping as
 * `aiFlowIdFor` in `../launcher.ts`. Mirrored here (rather than imported) so the helper does
 * not pull the entire launcher module into its dependency graph.
 */
const aiFlowIdForCheck = (flowId: string): FlowId | undefined => {
  switch (flowId) {
    case 'refine':
    case 'plan':
    case 'implement':
    case 'readiness':
    case 'ideate':
      return flowId;
    case 'detect-scripts':
    case 'detect-skills':
      return 'readiness';
    case 'review':
      return 'implement';
    default:
      return undefined;
  }
};

export interface CheckCliOptions {
  /** Test seam — defaults to the production `detectInstalledProviders`. */
  readonly detect?: () => Promise<ReadonlySet<AiProvider>>;
}

export const checkCli = async (
  flowId: string,
  settings: Settings,
  options: CheckCliOptions = {}
): Promise<LaunchResult | undefined> => {
  const aiFlow = aiFlowIdForCheck(flowId);
  if (aiFlow === undefined) return undefined;
  const provider = settings.ai[aiFlow].provider;
  const binary = PROVIDER_BINARY[provider];
  const detect = options.detect ?? (() => detectInstalledProviders());
  const installed = await detect();
  if (installed.has(provider)) return undefined;
  return {
    ok: false,
    reason: `CLI ${binary} not on PATH for flow ${aiFlow}. Change ai.${aiFlow}.provider or install the CLI.`,
  };
};
