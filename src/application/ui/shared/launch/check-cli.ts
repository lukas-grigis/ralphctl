/**
 * Fail-fast PATH check used by every launcher that opens an AI session. Resolves the configured
 * provider(s) for the flow's settings row(s), probes PATH for each provider's CLI binary, and
 * returns a `LaunchResult.fail` naming every missing binary, the flow, and the settings key
 * when absent. Returns `undefined` when every required binary is present — the launcher then
 * proceeds to construct the chain element.
 *
 * `implement` is special: it carries two roles (generator + evaluator) that may target
 * different providers. The check fans out across both rows and surfaces a single message
 * listing every missing role + provider rather than bailing on the first one — operators see
 * the full picture of what's broken in one shot.
 *
 * Detection only runs at the three sites in scope (fresh-install, preset-apply, launch); the
 * per-row Settings editor never triggers a probe. Within a single launch call the launcher
 * invokes this helper exactly once — no internal caching is needed.
 */

import {
  detectInstalledProviders,
  primaryInstallCommand,
  PROVIDER_BINARY,
  PROVIDER_INSTALL_GUIDANCE,
} from '@src/integration/system/detect-cli.ts';
import { type AiProvider, primaryFlowRow, type Settings } from '@src/domain/entity/settings.ts';
import type { FlowId } from '@src/domain/value/flow-id.ts';
import type { LaunchExtras, LaunchResult } from '@src/application/ui/shared/launcher.ts';

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
    case 'create-pr':
      // kebab orchestration id → camelCase settings row (mirrors `aiFlowIdFor`).
      return 'createPr';
    default:
      return undefined;
  }
};

export interface CheckCliOptions {
  /** Test seam — defaults to the production `detectInstalledProviders`. */
  readonly detect?: () => Promise<ReadonlySet<AiProvider>>;
  /**
   * Per-launch single-row override (from the TUI customize picker). When the missing
   * provider matches `override.provider`, the failure message names the source as a per-run
   * override rather than a saved settings key — the operator should not be told to "change
   * ai.<flow>.provider" when they actually picked it transiently from the picker.
   */
  readonly override?: LaunchExtras['override'];
  /**
   * Per-launch implement-role overrides (from the TUI customize picker or the bare-`ralphctl`
   * CLI flags). Same intent as {@link override}: when the missing provider for an implement
   * role matches its override, the failure message identifies the source as a per-run
   * override.
   */
  readonly implementRoleOverrides?: LaunchExtras['implementRoleOverrides'];
}

/**
 * One row's expectation under the launch-time probe. `role` is set for implement's two-row
 * fan-out (so the failure message can name the offending role); single-row flows leave it
 * undefined and the message names just the flow. `fromOverride` is `true` when the row's
 * provider was supplied by a per-launch override (TUI picker / CLI flag) — the failure
 * message then identifies the source as a per-run override rather than the settings key the
 * operator never actually edited.
 */
interface RowExpectation {
  readonly provider: AiProvider;
  readonly settingsKey: string;
  readonly role?: 'generator' | 'evaluator';
  readonly fromOverride: boolean;
}

const rowExpectationsFor = (
  aiFlow: FlowId,
  settings: Settings,
  options: CheckCliOptions
): readonly RowExpectation[] => {
  if (aiFlow === 'implement') {
    return [
      {
        provider: settings.ai.implement.generator.provider,
        settingsKey: 'ai.implement.generator.provider',
        role: 'generator',
        fromOverride: options.implementRoleOverrides?.generator?.provider !== undefined,
      },
      {
        provider: settings.ai.implement.evaluator.provider,
        settingsKey: 'ai.implement.evaluator.provider',
        role: 'evaluator',
        fromOverride: options.implementRoleOverrides?.evaluator?.provider !== undefined,
      },
    ];
  }
  return [
    {
      provider: primaryFlowRow(settings.ai, aiFlow).provider,
      settingsKey: `ai.${aiFlow}.provider`,
      fromOverride: options.override?.provider !== undefined,
    },
  ];
};

const renderMissing = (missing: readonly RowExpectation[], aiFlow: FlowId): string => {
  const formatOne = (m: RowExpectation): string => {
    const binary = PROVIDER_BINARY[m.provider];
    const installHint = primaryInstallCommand(m.provider);
    const docsUrl = PROVIDER_INSTALL_GUIDANCE[m.provider].docsUrl;
    const roleSuffix = m.role !== undefined ? ` (${m.role})` : '';
    // Per-run overrides come from the customize picker / CLI flag — the operator picked
    // this provider transiently and the saved settings key is unchanged. Naming "per-run
    // override" instead of the settings key prevents the operator from chasing the wrong
    // edit surface to undo the failure.
    const source = m.fromOverride ? `per-run override (${m.settingsKey} unchanged)` : m.settingsKey;
    return `CLI ${binary} not on PATH for flow ${aiFlow}${roleSuffix}. Change ${source} or install with: ${installHint} (alternatives: ${docsUrl}).`;
  };
  if (missing.length === 1) return formatOne(missing[0]!);
  return missing.map(formatOne).join(' ');
};

export const checkCli = async (
  flowId: string,
  settings: Settings,
  options: CheckCliOptions = {}
): Promise<LaunchResult | undefined> => {
  const aiFlow = aiFlowIdForCheck(flowId);
  if (aiFlow === undefined) return undefined;
  const expectations = rowExpectationsFor(aiFlow, settings, options);
  const detect = options.detect ?? (() => detectInstalledProviders());
  const installed = await detect();
  // Dedupe by provider+role — when implement's two roles target the same provider, a single
  // missing binary surfaces once per role, which is fine (the operator wants to know both
  // roles are blocked). For mixed configs each row surfaces independently.
  const missing = expectations.filter((e) => !installed.has(e.provider));
  if (missing.length === 0) return undefined;
  return { ok: false, reason: renderMissing(missing, aiFlow) };
};
