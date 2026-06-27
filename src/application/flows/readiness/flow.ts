import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import {
  type AiProvider,
  type AiSettings,
  primaryFlowRow,
  uniqueProvidersFromAi,
} from '@src/domain/entity/settings.ts';
import { Result } from '@src/domain/result.ts';
import { ErrorCode } from '@src/domain/value/error/error-code.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { Element } from '@src/application/chain/element.ts';
import { sequential } from '@src/application/chain/build/sequential.ts';
import { loadProjectLeaf } from '@src/application/flows/_shared/project/load.ts';
import { pickRepositoryLeaf } from '@src/application/flows/_shared/project/pick-repository.ts';
import type { ReadinessCtx } from '@src/application/flows/readiness/ctx.ts';
import type { SetupReadinessDeps } from '@src/application/flows/readiness/deps.ts';
import { confirmReadinessLeaf } from '@src/application/flows/readiness/leaves/confirm.ts';
import { installReadinessSkillsLeaf } from '@src/application/flows/readiness/leaves/install-readiness-skills.ts';
import { offerSkillSuggestionsLeaf } from '@src/application/flows/readiness/leaves/offer-skill-suggestions.ts';
import { persistSuggestedSkillsLeaf } from '@src/application/flows/readiness/leaves/persist-suggested-skills.ts';
import { probeReadinessLeaf } from '@src/application/flows/readiness/leaves/probe.ts';
import { proposeReadinessLeaf } from '@src/application/flows/readiness/leaves/propose.ts';
import { writeReadinessLeaf } from '@src/application/flows/readiness/leaves/write.ts';
import { installSkillsLeaf } from '@src/application/flows/_shared/skills/install-skills.ts';
import { uninstallSkillsLeaf } from '@src/application/flows/_shared/skills/uninstall-skills.ts';
import { allocateRunDirLeaf } from '@src/application/flows/_shared/allocate-run-dir.ts';
import { stampSessionMetaLeaf } from '@src/application/flows/_shared/stamp-session-meta.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { type AssistantTool, toolForProvider } from '@src/integration/ai/readiness/_engine/tool.ts';
import type { FlowId } from '@src/domain/value/flow-id.ts';
import { FLOW_IDS } from '@src/domain/value/flow-id.ts';

export interface CreateReadinessFlowOpts {
  readonly projectId: ProjectId;
  /**
   * Optional pre-selected repository. When supplied (the operator picked a repo at the
   * pre-launch picker), `pickRepositoryLeaf` auto-resolves without prompting; when omitted it
   * auto-selects a single-repo project or prompts on a multi-repo one. The launcher derives
   * `cwd` from the same repository so the AI session inventories the repo the chain picks.
   */
  readonly repositoryId?: RepositoryId;
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
  /**
   * Scope the fan-out to a subset of providers. When omitted the flow falls back to
   * {@link uniqueProvidersFromAi}(ai) — the historical "set up every configured provider"
   * behavior. The launcher passes a single-element list when the operator picks one provider at
   * launch, or every unique provider when they pick "All providers". Each entry must appear in
   * `ai` so `pickRowForProvider` can resolve a model + effort for it; the launcher derives the
   * list from the same settings, so that invariant always holds.
   */
  readonly providers?: readonly AiProvider[];
}

/**
 * Resolve which per-flow row carries the model for one provider. The readiness row wins when
 * its provider matches; otherwise the first per-flow row whose provider matches the requested
 * one. Walks `FLOW_IDS` in order so the choice is deterministic across runs. For `implement`
 * the generator row's provider is considered — readiness still treats one provider as
 * representative when both generator and evaluator share it.
 */
const pickRowForProvider = (ai: AiSettings, provider: AiProvider): FlowId => {
  if (ai.readiness.provider === provider) return 'readiness';
  for (const flow of FLOW_IDS) {
    if (primaryFlowRow(ai, flow).provider === provider) return flow;
  }
  // Caller derived the provider list from these same rows; unreachable.
  throw new Error(`pickRowForProvider: provider ${provider} not referenced in ai settings`);
};

/**
 * Per-tool effort resolution. Mirrors `resolveEffort(flowId, settings)` semantics but reads
 * just the `AiSettings` slice the flow holds — per-row effort wins, otherwise the global
 * effort is floored to what the provider's CLI accepts. Floor table matches
 * `business/settings/resolve-effort.ts`. For `implement` reads from the generator role.
 */
const resolveEffortForRow = (ai: AiSettings, flow: FlowId): string | undefined => {
  const row = primaryFlowRow(ai, flow);
  if (row.effort !== undefined) return row.effort;
  const globalEffort = ai.effort;
  if (globalEffort === undefined) return undefined;
  if (row.provider === 'openai-codex' && (globalEffort === 'xhigh' || globalEffort === 'max')) return 'high';
  return globalEffort;
};

/**
 * Error codes that represent a PROVIDER-SPECIFIC infrastructure failure — the kind it is safe to
 * skip past so the remaining providers still get set up. A filesystem failure inside this
 * provider's readiness probe (`probe-error`), or this provider's CLI being throttled after the
 * adapter exhausted its 429 retries (`rate-limit`), says nothing about the other providers.
 *
 * Everything NOT in this set propagates and fails the run:
 *  - Domain contract errors — the AI omitted a required signal (`invalid-state`), wrote malformed
 *    `signals.json` (`parse-error`), or a value failed validation (`invalid-value`). These are
 *    real defects the operator must see, not a provider to silently skip.
 *  - Spawn failures (provider CLI not on PATH, non-zero exit, model unavailable) also surface as
 *    `invalid-state`, so they propagate too — failing loudly on a misconfiguration beats hiding
 *    it. The code cannot be told apart from a contract violation, and surfacing both is correct.
 *  - Global infrastructure — a lock / I/O `storage-error` affects every provider, so it aborts the
 *    whole run rather than being swallowed per-provider.
 *  - `AbortError` (`aborted`) — operator cancellation; always propagates transparently.
 */
const PROVIDER_INFRASTRUCTURE_ERROR_CODES: ReadonlySet<ErrorCode> = new Set([ErrorCode.Probe, ErrorCode.RateLimit]);

/**
 * Wraps a per-provider subchain so that a provider-specific infrastructure failure emits a warn
 * banner and lets execution continue to the remaining providers. Only the codes in
 * {@link PROVIDER_INFRASTRUCTURE_ERROR_CODES} are tolerated — domain contract errors, global I/O
 * failures and operator AbortError all propagate so the run fails loudly or cancels.
 *
 * Exported so the continue-vs-propagate decision can be tested against a raw `Element` stub
 * without standing up the full fan-out.
 */
export const wrapProviderContinue = (
  eventBus: SetupReadinessDeps['eventBus'],
  provider: AiProvider,
  inner: Element<ReadinessCtx>
): Element<ReadinessCtx> => ({
  name: `continue-on-error(${inner.name})`,
  // Expose children so flattenLeaves walks the full per-provider step list for the TUI plan.
  children: [inner],
  async execute(ctx, signal, onTrace) {
    const result = await inner.execute(ctx, signal, onTrace);
    if (result.ok) return result;
    // Only a provider-specific infrastructure failure is tolerated — skip this provider and let
    // the fan-out continue. Everything else (contract errors, global I/O, abort) propagates.
    if (!PROVIDER_INFRASTRUCTURE_ERROR_CODES.has(result.error.error.code)) return result;
    // Provider-level infra failure (probe filesystem error, CLI throttle): surface as a warn
    // banner and continue to the next provider. The inner trace already recorded the failure.
    eventBus.publish({
      type: 'banner-show',
      id: `readiness-provider-error-${provider}`,
      tier: 'warn',
      message: `Provider '${provider}' readiness setup failed — skipping, other providers continue`,
      cause: result.error.error.message,
      at: IsoTimestamp.now(),
    });
    return Result.ok({ ctx, trace: result.error.trace });
  },
});

const buildPerToolSubchain = (
  deps: SetupReadinessDeps,
  opts: CreateReadinessFlowOpts,
  provider: AiProvider,
  tool: AssistantTool
): Element<ReadinessCtx> => {
  const rowFlow = pickRowForProvider(opts.ai, provider);
  const row = primaryFlowRow(opts.ai, rowFlow);
  const effort = resolveEffortForRow(opts.ai, rowFlow);
  const provideAi = deps.providerFor(provider);
  const skillsAdapter = deps.skillsAdapterFor(provider);
  return sequential<ReadinessCtx>(`tool-${tool}`, [
    probeReadinessLeaf({ probes: deps.probes, clock: deps.clock }, tool),
    installSkillsLeaf<ReadinessCtx>(
      { skillsAdapter, skillSource: deps.skillSource },
      { name: `install-skills-${tool}`, flowId: 'readiness', cwdPicker: () => opts.cwd }
    ),
    allocateRunDirLeaf<ReadinessCtx>({
      name: `allocate-run-dir-${tool}`,
      runsRoot: () => deps.runsRoot,
      flowSegment: 'readiness',
      write: (ctx, runDir) => ({
        ...ctx,
        entries: { ...ctx.entries, [tool]: { ...ctx.entries[tool], runDir } },
      }),
    }),
    stampSessionMetaLeaf<ReadinessCtx>(
      { writeFile: deps.writeFile, clock: deps.clock },
      {
        name: `stamp-meta-${tool}`,
        resolve: (ctx) => {
          const runDir = ctx.entries[tool]?.runDir;
          if (runDir === undefined) {
            throw new InvalidStateError({
              entity: 'chain',
              currentState: 'pre-stamp-meta',
              attemptedAction: `stamp-meta-${tool}`,
              message: `stamp-meta-${tool}: runDir missing — allocate-run-dir-${tool} must run first`,
            });
          }
          return {
            outputDir: runDir,
            flow: 'readiness',
            provider: row.provider,
            model: row.model,
            effort: effort ?? null,
          };
        },
      }
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
      },
      tool
    ),
    uninstallSkillsLeaf<ReadinessCtx>(
      { skillsAdapter },
      { name: `uninstall-skills-${tool}`, cwdPicker: () => opts.cwd }
    ),
    confirmReadinessLeaf({ interactive: deps.interactive }, tool),
    writeReadinessLeaf({ writeFile: deps.writeFile, logger: deps.logger, clock: deps.clock }, tool),
    offerSkillSuggestionsLeaf(
      { interactive: deps.interactive, skillSource: deps.skillSource, skillsAdapter, logger: deps.logger },
      tool
    ),
    installReadinessSkillsLeaf({ skillsAdapter, logger: deps.logger }, tool),
  ]);
};

/**
 * Build the readiness chain — fans out to `opts.providers` when supplied, otherwise to every
 * uniquely referenced provider in `settings.ai`.
 *
 * Shape:
 *
 *   sequential('readiness', [
 *     load-project,
 *     pick-repository,                       // interactive (auto-selects single-repo projects)
 *     // one per-tool sub-chain per unique provider in settings.ai (order follows FLOW_IDS), each
 *     // wrapped in a continue-on-error guard so a provider-specific infra failure skips that
 *     // provider while the fan-out carries on:
 *     continue-on-error(sequential('tool-claude-code', [ probe → install-skills → propose →
 *                                       uninstall-skills → confirm → write →
 *                                       offer-skill-suggestions → install-readiness-skills ])),
 *     continue-on-error(sequential('tool-copilot',    [ … ])),
 *     continue-on-error(sequential('tool-codex',      [ … ])),
 *     persist-suggested-skills,             // one save: union of every tool's suggestions
 *   ])
 *
 * Each per-tool sub-chain uses provider-specific headless / skills adapters resolved via
 * `deps.providerFor` and `deps.skillsAdapterFor`. The model and effort for each sub-chain come
 * from the per-flow row whose provider matches (readiness row preferred when it does).
 */
export const createReadinessFlow = (deps: SetupReadinessDeps, opts: CreateReadinessFlowOpts): Element<ReadinessCtx> => {
  // Default to every uniquely-referenced provider (historical behavior); a launcher-supplied
  // `providers` list scopes the fan-out to the operator's pick. Per-provider model resolution
  // still reads the full `opts.ai`, so any provider in the list resolves correctly.
  const providers = opts.providers ?? uniqueProvidersFromAi(opts.ai);
  const perToolSubchains = providers.map((provider) =>
    wrapProviderContinue(deps.eventBus, provider, buildPerToolSubchain(deps, opts, provider, toolForProvider(provider)))
  );
  return sequential<ReadinessCtx>('readiness', [
    loadProjectLeaf<ReadinessCtx>({ projectRepo: deps.projectRepo }),
    pickRepositoryLeaf<ReadinessCtx>(
      { interactive: deps.interactive },
      {
        promptMessage: 'Which repository do you want to set up readiness for?',
        emptyVerb: 'set up readiness for',
        preselectedFromCtx: (ctx) => ctx.repositoryId,
      }
    ),
    ...perToolSubchains,
    // Runs ONCE after the whole fan-out: union every tool's proposed skill suggestions and
    // persist them onto the repository's durable record (regardless of accept / decline).
    persistSuggestedSkillsLeaf({ projectRepo: deps.projectRepo, logger: deps.logger }),
  ]);
};
