import type { Element } from '@src/application/chain/element.ts';
import { createRunner, type Runner } from '@src/application/chain/run/runner.ts';
import { createReadinessFlow } from '@src/application/flows/readiness/flow.ts';
import type { ReadinessCtx } from '@src/application/flows/readiness/ctx.ts';
import { type AiProvider, primaryFlowRow, uniqueProvidersFromAi } from '@src/domain/entity/settings.ts';
import { toolForProvider } from '@src/integration/ai/readiness/_engine/tool.ts';
import { createAiProvider } from '@src/application/bootstrap/provider-factory.ts';
import { createSkillsAdapter } from '@src/integration/ai/skills/adapter-factory.ts';
import type { InteractivePrompt } from '@src/business/interactive/prompt.ts';
import type { LaunchContext } from '@src/application/ui/shared/launch/context.ts';
import type { LaunchResult } from '@src/application/ui/shared/launcher.ts';
import { checkCli } from '@src/application/ui/shared/launch/check-cli.ts';
import type { HeadlessAiProvider } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { SkillsAdapter } from '@src/integration/ai/skills/_engine/skills-port.ts';
import type { FlowId } from '@src/domain/value/flow-id.ts';
import { FLOW_IDS } from '@src/domain/value/flow-id.ts';

/** Human-facing provider names for the launch-time picker. */
const PROVIDER_LABEL: Record<AiProvider, string> = {
  'claude-code': 'Claude Code',
  'github-copilot': 'GitHub Copilot',
  'openai-codex': 'OpenAI Codex',
  opencode: 'OpenCode',
  'xai-grok': 'Grok',
};

/** Sentinel for the picker's "All providers" entry — distinct from any {@link AiProvider}. */
const ALL_PROVIDERS = '__all__' as const;

/** Outcome of {@link selectReadinessProviders}: a provider scope to run, or an operator cancel. */
type ProviderSelection =
  { readonly cancelled: true } | { readonly cancelled: false; readonly providers: readonly AiProvider[] };

/**
 * Resolve which provider(s) readiness should set up. Skills / native context files are provider-specific, so the
 * operator usually wants ONE provider per run.
 * @public — exported for direct unit testing of the launch-time provider scoping (the launcher
 */
export const selectReadinessProviders = async (
  allProviders: readonly AiProvider[],
  interactive: InteractivePrompt
): Promise<ProviderSelection> => {
  // Zero or one configured provider → nothing to choose between; run the implicit scope.
  if (allProviders.length <= 1) return { cancelled: false, providers: allProviders };

  const choices = [
    ...allProviders.map((provider) => ({
      label: PROVIDER_LABEL[provider],
      value: provider as AiProvider | typeof ALL_PROVIDERS,
    })),
    {
      label: 'All providers',
      value: ALL_PROVIDERS as AiProvider | typeof ALL_PROVIDERS,
      description: 'Set up every configured provider (default).',
    },
  ];
  const picked = await interactive.askChoice<AiProvider | typeof ALL_PROVIDERS>(
    'Which AI provider should readiness set up?',
    choices
  );
  if (!picked.ok) return { cancelled: true };
  if (picked.value === ALL_PROVIDERS) return { cancelled: false, providers: allProviders };
  return { cancelled: false, providers: [picked.value] };
};

/**
 * Pick the per-flow id whose row references `provider` — readiness wins when its provider matches, otherwise the
 * first member of `FLOW_IDS` whose row matches.
 */
const flowIdForProvider = (settings: LaunchContext['settings'], provider: AiProvider): FlowId => {
  if (settings.ai.readiness.provider === provider) return 'readiness';
  for (const flow of FLOW_IDS) {
    if (primaryFlowRow(settings.ai, flow).provider === provider) return flow;
  }
  // Caller derived `provider` from the same settings; unreachable.
  throw new Error(`flowIdForProvider: provider ${provider} not referenced in ai settings`);
};

/** One adapter per provider, even when several per-tool sub-chains reference it. */
const buildAdapterCaches = (
  { deps, settings }: LaunchContext,
  providers: readonly AiProvider[]
): {
  readonly providerFor: (provider: AiProvider) => HeadlessAiProvider;
  readonly skillsAdapterFor: (provider: AiProvider) => SkillsAdapter;
} => {
  const providerCache = new Map<AiProvider, HeadlessAiProvider>();
  const skillsCache = new Map<AiProvider, SkillsAdapter>();
  for (const provider of providers) {
    providerCache.set(
      provider,
      createAiProvider({
        flow: flowIdForProvider(settings, provider),
        ai: settings.ai,
        harnessConfig: settings.harness,
        eventBus: deps.app.eventBus,
        childRegistry: deps.app.childRegistry,
        ...(deps.app.providerSpawn !== undefined ? { spawn: deps.app.providerSpawn } : {}),
      })
    );
    skillsCache.set(provider, createSkillsAdapter({ provider, logger: deps.app.logger }));
  }
  return {
    providerFor: (provider) => {
      const adapter = providerCache.get(provider);
      if (adapter === undefined) throw new Error(`launchReadiness: no provider adapter cached for ${provider}`);
      return adapter;
    },
    skillsAdapterFor: (provider) => {
      const adapter = skillsCache.get(provider);
      if (adapter === undefined) throw new Error(`launchReadiness: no skills adapter cached for ${provider}`);
      return adapter;
    },
  };
};

export const launchReadiness = async (ctx: LaunchContext): Promise<LaunchResult> => {
  const { deps, snapshot, settings, bridge, sessionId } = ctx;
  const missing = await checkCli('readiness', settings, { override: ctx.extras.override });
  if (missing !== undefined) return missing;
  if (!snapshot.project) return { ok: false, reason: 'No project loaded.' };

  // Resolve the repository readiness should set up: the operator's pre-launch pick when present and still on the
  // project, otherwise the first repository (today's fallback).
  const targetRepo =
    ctx.extras.repositoryId !== undefined
      ? snapshot.project.repositories.find((r) => r.id === ctx.extras.repositoryId)
      : undefined;
  const resolvedRepo = targetRepo ?? snapshot.project.repositories[0];
  const cwd = resolvedRepo?.path;
  if (!cwd) return { ok: false, reason: 'No repository path resolvable from the project.' };

  // Skills / native context files are provider-specific, so let the operator scope readiness to one provider at
  // launch (or "All providers" to keep the historical fan-out).
  const allProviders = uniqueProvidersFromAi(settings.ai);
  const selection = await selectReadinessProviders(allProviders, deps.interactive);
  if (selection.cancelled) return { ok: false, reason: 'Cancelled.' };
  const scopedProviders = selection.providers;

  const { providerFor, skillsAdapterFor } = buildAdapterCaches(ctx, scopedProviders);

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
      ...(resolvedRepo?.id !== undefined ? { repositoryId: resolvedRepo.id } : {}),
      cwd,
      ai: settings.ai,
      providers: scopedProviders,
    }
  );
  const tools = scopedProviders.map(toolForProvider);
  const runner = createRunner<ReadinessCtx>({
    id: sessionId(),
    element,
    initialCtx: {
      projectId: snapshot.project.id,
      tools,
      entries: {},
      ...(resolvedRepo?.id !== undefined ? { repositoryId: resolvedRepo.id } : {}),
    },
  });
  return {
    ok: true,
    runner: bridge(runner) as Runner<unknown>,
    title: `Readiness — ${snapshot.project.displayName}`,
  };
};
