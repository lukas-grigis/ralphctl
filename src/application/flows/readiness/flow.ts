import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { AiProvider, AiSettings } from '@src/domain/entity/settings.ts';
import type { Element } from '@src/application/chain/element.ts';
import { sequential } from '@src/application/chain/build/sequential.ts';
import { loadProjectLeaf } from '@src/application/flows/_shared/project/load.ts';
import { pickRepositoryLeaf } from '@src/application/flows/_shared/project/pick-repository.ts';
import type { ReadinessCtx } from '@src/application/flows/readiness/ctx.ts';
import type { SetupReadinessDeps } from '@src/application/flows/readiness/deps.ts';
import { confirmReadinessLeaf } from '@src/application/flows/readiness/leaves/confirm.ts';
import { installReadinessSkillsLeaf } from '@src/application/flows/readiness/leaves/install-readiness-skills.ts';
import { probeReadinessLeaf } from '@src/application/flows/readiness/leaves/probe.ts';
import { proposeReadinessLeaf } from '@src/application/flows/readiness/leaves/propose.ts';
import { writeReadinessLeaf } from '@src/application/flows/readiness/leaves/write.ts';
import { installSkillsLeaf } from '@src/application/flows/_shared/skills/install-skills.ts';
import { uninstallSkillsLeaf } from '@src/application/flows/_shared/skills/uninstall-skills.ts';
import { toolForProvider, type AssistantTool } from '@src/integration/ai/readiness/_engine/tool.ts';
import type { FlowId } from '@src/domain/value/flow-id.ts';
import { FLOW_IDS } from '@src/domain/value/flow-id.ts';

export interface CreateReadinessFlowOpts {
  readonly projectId: ProjectId;
  /**
   * Working directory passed to each per-tool AI session. Captured at chain-construction;
   * switching repositories mid-run is out of scope — one chain run sets up readiness for one
   * repository.
   */
  readonly cwd: AbsolutePath;
  /**
   * Flat AI settings — the flow inspects every per-flow row to derive the unique provider set
   * and to pick a model + effort for each tool's AI session.
   */
  readonly ai: AiSettings;
}

/**
 * Resolve which per-flow row carries the model for one provider. The readiness row wins when
 * its provider matches; otherwise the first per-flow row whose provider matches the requested
 * one. Walks `FLOW_IDS` in order so the choice is deterministic across runs.
 */
const pickRowForProvider = (ai: AiSettings, provider: AiProvider): FlowId => {
  if (ai.readiness.provider === provider) return 'readiness';
  for (const flow of FLOW_IDS) {
    if (ai[flow].provider === provider) return flow;
  }
  // Caller derived the provider list from these same rows; unreachable.
  throw new Error(`pickRowForProvider: provider ${provider} not referenced in ai settings`);
};

/**
 * Compute the unique providers referenced across all five per-flow rows, preserving the order
 * they first appear in `FLOW_IDS`. Used by {@link createReadinessFlow} to decide which native
 * context files to write — one per unique provider.
 */
export const uniqueProvidersFromAi = (ai: AiSettings): readonly AiProvider[] => {
  const seen = new Set<AiProvider>();
  const ordered: AiProvider[] = [];
  for (const flow of FLOW_IDS) {
    const provider = ai[flow].provider;
    if (!seen.has(provider)) {
      seen.add(provider);
      ordered.push(provider);
    }
  }
  return ordered;
};

/**
 * Per-tool effort resolution. Mirrors `resolveEffort(flowId, settings)` semantics but reads
 * just the `AiSettings` slice the flow holds — per-row effort wins, otherwise the global
 * effort is floored to what the provider's CLI accepts. Floor table matches
 * `business/settings/resolve-effort.ts`.
 */
const resolveEffortForRow = (ai: AiSettings, flow: FlowId): string | undefined => {
  const row = ai[flow];
  if (row.effort !== undefined) return row.effort;
  const globalEffort = ai.effort;
  if (globalEffort === undefined) return undefined;
  if (row.provider === 'openai-codex' && (globalEffort === 'xhigh' || globalEffort === 'max')) return 'high';
  return globalEffort;
};

const buildPerToolSubchain = (
  deps: SetupReadinessDeps,
  opts: CreateReadinessFlowOpts,
  provider: AiProvider,
  tool: AssistantTool
): Element<ReadinessCtx> => {
  const rowFlow = pickRowForProvider(opts.ai, provider);
  const row = opts.ai[rowFlow];
  const effort = resolveEffortForRow(opts.ai, rowFlow);
  const provideAi = deps.providerFor(provider);
  const skillsAdapter = deps.skillsAdapterFor(provider);
  return sequential<ReadinessCtx>(`tool-${tool}`, [
    probeReadinessLeaf({ probes: deps.probes, clock: deps.clock }, tool),
    installSkillsLeaf<ReadinessCtx>(
      { skillsAdapter, skillSource: deps.skillSource },
      { name: `install-skills-${tool}`, flowId: 'readiness', cwdPicker: () => opts.cwd }
    ),
    proposeReadinessLeaf(
      {
        provider: provideAi,
        templateLoader: deps.templateLoader,
        writeFile: deps.writeFile,
        eventBus: deps.eventBus,
        logger: deps.logger,
        cwd: opts.cwd,
        model: row.model,
        ...(effort !== undefined ? { effort } : {}),
        runsRoot: deps.runsRoot,
      },
      tool
    ),
    uninstallSkillsLeaf<ReadinessCtx>(
      { skillsAdapter },
      { name: `uninstall-skills-${tool}`, cwdPicker: () => opts.cwd }
    ),
    confirmReadinessLeaf({ interactive: deps.interactive }, tool),
    writeReadinessLeaf({ writeFile: deps.writeFile, logger: deps.logger, clock: deps.clock }, tool),
    installReadinessSkillsLeaf({ skillsAdapter, logger: deps.logger }, tool),
  ]);
};

/**
 * Build the readiness chain — fans out to every uniquely referenced provider in `settings.ai`.
 *
 * Shape:
 *
 *   sequential('readiness', [
 *     load-project,
 *     pick-repository,                       // interactive (auto-selects single-repo projects)
 *     // one per-tool sub-chain per unique provider in settings.ai (order follows FLOW_IDS):
 *     sequential('tool-claude-code', [ probe → install-skills → propose → uninstall-skills →
 *                                       confirm → write → install-readiness-skills ]),
 *     sequential('tool-copilot',    [ … ]),
 *     sequential('tool-codex',      [ … ]),
 *   ])
 *
 * Each per-tool sub-chain uses provider-specific headless / skills adapters resolved via
 * `deps.providerFor` and `deps.skillsAdapterFor`. The model and effort for each sub-chain come
 * from the per-flow row whose provider matches (readiness row preferred when it does).
 */
export const createReadinessFlow = (deps: SetupReadinessDeps, opts: CreateReadinessFlowOpts): Element<ReadinessCtx> => {
  const providers = uniqueProvidersFromAi(opts.ai);
  const perToolSubchains = providers.map((provider) =>
    buildPerToolSubchain(deps, opts, provider, toolForProvider(provider))
  );
  return sequential<ReadinessCtx>('readiness', [
    loadProjectLeaf<ReadinessCtx>({ projectRepo: deps.projectRepo }),
    pickRepositoryLeaf<ReadinessCtx>(
      { interactive: deps.interactive },
      {
        promptMessage: 'Which repository do you want to set up readiness for?',
        emptyVerb: 'set up readiness for',
      }
    ),
    ...perToolSubchains,
  ]);
};
