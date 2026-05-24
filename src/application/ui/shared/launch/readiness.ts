import type { Element } from '@src/application/chain/element.ts';
import { createRunner, type Runner } from '@src/application/chain/run/runner.ts';
import { createReadinessFlow } from '@src/application/flows/readiness/flow.ts';
import type { ReadinessCtx } from '@src/application/flows/readiness/ctx.ts';
import { uniqueProvidersFromAi } from '@src/application/flows/readiness/flow.ts';
import { toolForProvider } from '@src/integration/ai/readiness/_engine/tool.ts';
import { createAiProvider } from '@src/application/bootstrap/provider-factory.ts';
import { createSkillsAdapter } from '@src/integration/ai/skills/adapter-factory.ts';
import type { LaunchContext } from '@src/application/ui/shared/launch/context.ts';
import type { LaunchResult } from '@src/application/ui/shared/launcher.ts';
import { checkCli } from '@src/application/ui/shared/launch/check-cli.ts';
import { primaryFlowRow, type AiProvider } from '@src/domain/entity/settings.ts';
import type { HeadlessAiProvider } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { SkillsAdapter } from '@src/integration/ai/skills/_engine/skills-port.ts';
import type { FlowId } from '@src/domain/value/flow-id.ts';
import { FLOW_IDS } from '@src/domain/value/flow-id.ts';

/**
 * Pick the per-flow id whose row references `provider` — readiness wins when its provider
 * matches, otherwise the first member of `FLOW_IDS` whose row matches. Keeps the
 * per-provider adapter rebuild aligned with the model + harness config the launcher hands to
 * `createAiProvider`. Mirrors the resolution rule baked into `createReadinessFlow`.
 */
const flowIdForProvider = (settings: LaunchContext['settings'], provider: AiProvider): FlowId => {
  if (settings.ai.readiness.provider === provider) return 'readiness';
  for (const flow of FLOW_IDS) {
    if (primaryFlowRow(settings.ai, flow).provider === provider) return flow;
  }
  // Caller derived `provider` from the same settings; unreachable.
  throw new Error(`flowIdForProvider: provider ${provider} not referenced in ai settings`);
};

export const launchReadiness = async (ctx: LaunchContext): Promise<LaunchResult> => {
  const { deps, snapshot, settings, cwd, bridge, sessionId } = ctx;
  const missing = await checkCli('readiness', settings);
  if (missing !== undefined) return missing;
  if (!snapshot.project) return { ok: false, reason: 'No project loaded.' };
  if (!cwd) return { ok: false, reason: 'No repository path resolvable from the project.' };

  // Build per-provider adapter caches keyed by AiProvider so each provider only constructs one
  // adapter even when several per-tool sub-chains reference it. The flow calls these factories
  // once per unique tool.
  const providerCache = new Map<AiProvider, HeadlessAiProvider>();
  const skillsCache = new Map<AiProvider, SkillsAdapter>();
  for (const provider of uniqueProvidersFromAi(settings.ai)) {
    providerCache.set(
      provider,
      createAiProvider({
        flow: flowIdForProvider(settings, provider),
        ai: settings.ai,
        harnessConfig: settings.harness,
        eventBus: deps.app.eventBus,
      })
    );
    skillsCache.set(provider, createSkillsAdapter({ provider, logger: deps.app.logger }));
  }
  const providerFor = (provider: AiProvider): HeadlessAiProvider => {
    const adapter = providerCache.get(provider);
    if (adapter === undefined) throw new Error(`launchReadiness: no provider adapter cached for ${provider}`);
    return adapter;
  };
  const skillsAdapterFor = (provider: AiProvider): SkillsAdapter => {
    const adapter = skillsCache.get(provider);
    if (adapter === undefined) throw new Error(`launchReadiness: no skills adapter cached for ${provider}`);
    return adapter;
  };

  const element: Element<ReadinessCtx> = createReadinessFlow(
    {
      projectRepo: deps.app.projectRepo,
      probes: deps.app.probes,
      providerFor,
      skillsAdapterFor,
      templateLoader: deps.app.templateLoader,
      eventBus: deps.app.eventBus,
      logger: deps.app.logger,
      interactive: deps.interactive,
      writeFile: deps.app.writeFile,
      clock: deps.app.clock,
      skillSource: ctx.skillSource,
      runsRoot: deps.storage.runsRoot,
    },
    {
      projectId: snapshot.project.id,
      cwd,
      ai: settings.ai,
    }
  );
  const tools = uniqueProvidersFromAi(settings.ai).map(toolForProvider);
  const runner = createRunner<ReadinessCtx>({
    id: sessionId(),
    element,
    initialCtx: { projectId: snapshot.project.id, tools, entries: {} },
  });
  return {
    ok: true,
    runner: bridge(runner) as Runner<unknown>,
    title: `Readiness — ${snapshot.project.displayName}`,
  };
};
