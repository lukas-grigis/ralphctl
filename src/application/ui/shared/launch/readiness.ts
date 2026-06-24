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
};

/** Sentinel for the picker's "All providers" entry — distinct from any {@link AiProvider}. */
const ALL_PROVIDERS = '__all__' as const;

/**
 * Outcome of {@link selectReadinessProviders}: a provider scope to run, or an operator cancel.
 * Cancel is surfaced as a discriminated variant rather than an empty list so the launcher can
 * return the same "do not launch" {@link LaunchResult} that the rest of the launchers use for a
 * cancelled prompt, without conflating it with a (never-empty) provider scope.
 */
type ProviderSelection =
  | { readonly cancelled: true }
  | { readonly cancelled: false; readonly providers: readonly AiProvider[] };

/**
 * Resolve which provider(s) readiness should set up. Skills / native context files are
 * provider-specific, so the operator usually wants ONE provider per run. When several providers
 * are configured we prompt; a single-provider config skips the prompt entirely (the lone
 * provider is the only possible scope). The final "All providers" entry preserves the historical
 * fan-out-to-everything behavior.
 *
 * Cancel (Esc / Ctrl+C → `AbortError`, `.ok === false`) returns `{ cancelled: true }` so the
 * launcher bails without constructing a runner.
 *
 * @public — exported for direct unit testing of the launch-time provider scoping (the launcher
 * itself runs a real PATH probe via `checkCli`, which is unfriendly to a deterministic unit test).
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
  const missing = await checkCli('readiness', settings, { override: ctx.extras.override });
  if (missing !== undefined) return missing;
  if (!snapshot.project) return { ok: false, reason: 'No project loaded.' };
  if (!cwd) return { ok: false, reason: 'No repository path resolvable from the project.' };

  // Skills / native context files are provider-specific, so let the operator scope readiness to
  // one provider at launch (or "All providers" to keep the historical fan-out). A single-provider
  // config skips the prompt. Cancel (Esc / Ctrl+C) bails without launching.
  const allProviders = uniqueProvidersFromAi(settings.ai);
  const selection = await selectReadinessProviders(allProviders, deps.interactive);
  if (selection.cancelled) return { ok: false, reason: 'Cancelled.' };
  const scopedProviders = selection.providers;

  // Build per-provider adapter caches keyed by AiProvider so each provider only constructs one
  // adapter even when several per-tool sub-chains reference it. Built over the SCOPED provider
  // list so a single-provider pick never constructs the other providers' adapters. The flow calls
  // these factories once per scoped tool.
  const providerCache = new Map<AiProvider, HeadlessAiProvider>();
  const skillsCache = new Map<AiProvider, SkillsAdapter>();
  for (const provider of scopedProviders) {
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
      providers: scopedProviders,
    }
  );
  const tools = scopedProviders.map(toolForProvider);
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
