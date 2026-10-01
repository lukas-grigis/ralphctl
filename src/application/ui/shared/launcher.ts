/**
 * Bridges flow manifests → live `Element` instances. {@link launchFlow} resolves cross-cutting inputs (fresh
 * settings, runner→event-bus bridge, composed skill source) and dispatches to a per-flow `launch<X>` under `./launch/`.
 */

import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { StoragePaths } from '@src/application/bootstrap/storage-paths.ts';
import type { Runner } from '@src/application/chain/run/runner.ts';
import type { RecoveryContext } from '@src/domain/entity/attempt.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { bridgeRunnerToEventBus } from '@src/application/observability/chain-runner-bridge.ts';
import { createAiProvider } from '@src/application/bootstrap/provider-factory.ts';
import { createInteractiveAiProvider } from '@src/application/bootstrap/interactive-provider-factory.ts';
import { createSkillsAdapter } from '@src/integration/ai/skills/adapter-factory.ts';
import type { InteractivePrompt } from '@src/business/interactive/prompt.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { AppStateSnapshot } from '@src/application/ui/shared/state-snapshot.ts';
import type { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import { composeSkillSources, createProjectSkillSource } from '@src/integration/ai/skills/project/source.ts';
import { createOperatorSkillSource } from '@src/integration/ai/skills/operator/source.ts';
import { createPhaseSkillSource, PHASE_FLOW_DIR } from '@src/integration/ai/skills/phase/source.ts';
import { createResolvedSkillSource } from '@src/integration/ai/skills/_engine/resolve-selection.ts';
import type { SkillSource } from '@src/integration/ai/skills/_engine/skill-source.ts';
import type { Skill } from '@src/integration/ai/skills/_engine/skill.ts';
import { warnIfContractViolated as checkContract } from '@src/integration/ai/skills/_engine/skill-contract-checker.ts';
import { type AiFlowSettings, type AiProvider, primaryFlowRow, type Settings } from '@src/domain/entity/settings.ts';
import { FLOW_IDS, type FlowId } from '@src/domain/value/flow-id.ts';
import { resolveEffort } from '@src/business/settings/resolve-effort.ts';
import type { RunInTerminal } from '@src/application/ui/shared/run-in-terminal.ts';
import type { LaunchContext } from '@src/application/ui/shared/launch/context.ts';
import { launchCreateSprint } from '@src/application/ui/shared/launch/create-sprint.ts';
import { launchRefine } from '@src/application/ui/shared/launch/refine.ts';
import { launchPlan } from '@src/application/ui/shared/launch/plan.ts';
import { launchImplement } from '@src/application/ui/shared/launch/implement.ts';
import { launchReview } from '@src/application/ui/shared/launch/review.ts';
import { launchCloseSprint } from '@src/application/ui/shared/launch/close-sprint.ts';
import { launchReadiness } from '@src/application/ui/shared/launch/readiness.ts';
import { launchDetectSkills } from '@src/application/ui/shared/launch/detect-skills.ts';
import { launchDetectScripts } from '@src/application/ui/shared/launch/detect-scripts.ts';
import { launchIdeate } from '@src/application/ui/shared/launch/ideate.ts';

export type LaunchResult =
  | {
      readonly ok: true;
      readonly runner: Runner<unknown>;
      readonly title: string;
      /** Optional `taskId → displayName` map for runs that operate on a fixed task set. */
      readonly taskNames?: ReadonlyMap<string, string>;
      /** Configured `maxTurns` for the run's gen-eval loop, surfaced as `round N/M` in the panel. */
      readonly maxTurns?: number;
      /** Configured `maxAttempts` per task, surfaced as the `/X` in `attempt N/X` in the panel. */
      readonly maxAttempts?: number;
      /**
       * Static element-tree leaf names in DFS order, computed at chain-construction time via {@link flattenLeaves}.
       */
      readonly plannedLeaves?: readonly string[];
      /** Display label per planned leaf name (keyed by element `name`). */
      readonly planLabelByName?: ReadonlyMap<string, string>;
      /**
       * Name of the per-task subchain's final leaf — when this name (with the task uuid suffix stripped) appears in
       * the trace for a task, the UI flips that task to `completed`.
       */
      readonly terminalSubstepName?: string;
      /**
       * Map of `taskId → RecoveryContext` for tasks the launcher detected as resuming a prior aborted attempt.
       */
      readonly taskRecovering?: ReadonlyMap<string, RecoveryContext>;
      /**
       * Implement-flow gen-eval models, projected onto the SessionDescriptor so the execute view can render
       * `<gen-model> → <eval-model> (eval)` on the active-attempt rail when the two roles point at different models.
       */
      readonly generatorModel?: string;
      readonly evaluatorModel?: string;
      /** Provider id backing each implement role (`claude-code` / `github-copilot` / `openai-codex`). */
      readonly generatorProvider?: AiProvider;
      readonly evaluatorProvider?: AiProvider;
      /** Resolved effort strings for each implement role (`low|medium|high|xhigh|max`). */
      readonly generatorEffort?: string;
      readonly evaluatorEffort?: string;
      /** Project and sprint the run was launched against, pinned at launch time for the run's lifetime. */
      readonly pinnedProjectId?: ProjectId;
      readonly pinnedProjectLabel?: string;
      readonly pinnedSprintId?: SprintId;
      readonly pinnedSprintLabel?: string;
    }
  | { readonly ok: false; readonly reason: string };

/** Optional per-launch overrides supplied by the caller. */
export interface LaunchExtras {
  readonly repositoryId?: RepositoryId;
  /**
   * Per-launch single-row override (refine / plan / readiness / ideate plus the implement- generator-driven flows
   * review / detect-scripts / detect-skills).
   */
  readonly override?: {
    readonly provider?: AiProvider;
    readonly model?: string;
    readonly effort?: string;
  };
  /** Freshly-loaded settings snapshot; overrides the stale `app.settings` boot snapshot. */
  readonly settingsSnapshot?: Settings;
  /**
   * Per-launch implement-role overrides — from the bare-`ralphctl` `--implement-{generator,evaluator}-{provider,model}`
   * flags or the TUI's customize picker. Each field is optional; an unset one keeps the persisted value.
   */
  readonly implementRoleOverrides?: {
    readonly generator?: {
      readonly provider?: AiProvider;
      readonly model?: string;
      readonly effort?: string;
    };
    readonly evaluator?: {
      readonly provider?: AiProvider;
      readonly model?: string;
      readonly effort?: string;
    };
  };
  /** Per-run skill opt-out, supplied by the TUI customize picker's skills step. */
  readonly skillsOverride?: { readonly disabled: readonly string[] };
}

export interface LauncherDeps {
  readonly app: AppDeps;
  readonly interactive: InteractivePrompt;
  readonly storage: StoragePaths;
  /**
   * Pause-the-host helper for interactive AI sessions (refine, plan-interactive). Threaded by `launchTui` from the
   * live Ink instance; tests pass a passthrough.
   */
  readonly runInTerminal: RunInTerminal;
}

/**
 * The subset of {@link LauncherDeps} that skill-source composition actually reads.
 * @public
 */
export type SkillCompositionDeps = Pick<LauncherDeps, 'app' | 'storage'>;

const sessionId = (): string => `r-${Math.random().toString(36).slice(2, 10)}-${String(Date.now())}`;

/** The `ok: true` branch of {@link LaunchResult} — the shape {@link sessionHintsFromLaunchResult} reads. */
type LaunchOk = Extract<LaunchResult, { readonly ok: true }>;

/** Optional UI-hint field names projected by {@link sessionHintsFromLaunchResult}. */
const HINT_KEYS = [
  'taskNames',
  'maxTurns',
  'maxAttempts',
  'plannedLeaves',
  'planLabelByName',
  'terminalSubstepName',
  'taskRecovering',
  'generatorModel',
  'evaluatorModel',
  'generatorProvider',
  'evaluatorProvider',
  'generatorEffort',
  'evaluatorEffort',
  'pinnedProjectId',
  'pinnedProjectLabel',
  'pinnedSprintId',
  'pinnedSprintLabel',
] as const satisfies ReadonlyArray<keyof LaunchOk>;

/** Copy the subset of `keys` whose value on `obj` is not `undefined` into a fresh object. */
const pickDefined = <T extends object, K extends keyof T>(obj: T, keys: readonly K[]): Pick<T, K> => {
  const picked = {} as Pick<T, K>;
  for (const key of keys) {
    const value = obj[key];
    if (value !== undefined) picked[key] = value;
  }
  return picked;
};

/**
 * Project the optional UI-hint fields from a successful {@link LaunchResult} into the shape `SessionManager.register`
 * accepts.
 */
export const sessionHintsFromLaunchResult = (result: LaunchOk): Pick<LaunchOk, (typeof HINT_KEYS)[number]> =>
  pickDefined(result, HINT_KEYS);

/**
 * Map a launcher flow id to the {@link FlowId} that owns the AI session, or `undefined` for flows that don't open
 * one.
 */
const aiFlowIdFor = (flowId: string): FlowId | undefined => {
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
      // The kebab-case orchestration id maps to its camelCase settings row.
      return 'createPr';
    default:
      return undefined;
  }
};

/**
 * Flows whose AI session actually gets a composed skill source installed — the only flows where a per-run skills
 * customization has any effect.
 * @public
 */
export const flowMountsSkills = (flowId: string): boolean =>
  flowId === 'refine' ||
  flowId === 'plan' ||
  flowId === 'implement' ||
  flowId === 'readiness' ||
  flowId === 'ideate' ||
  flowId === 'create-pr';

/**
 * Every {@link FlowId} whose launch context actually mounts a skill source, derived from {@link flowMountsSkills}
 * (the single source of truth) keyed back to `FlowId` via {@link PHASE_FLOW_DIR}.
 * @public
 */
export const SKILL_MOUNTING_FLOW_IDS: readonly FlowId[] = FLOW_IDS.filter((flowId) =>
  flowMountsSkills(PHASE_FLOW_DIR[flowId])
);

/** Per-field merge of `override` onto an `AiFlowSettings` row. */
const mergeRow = (base: AiFlowSettings, override: NonNullable<LaunchExtras['override']>): AiFlowSettings => {
  const provider = override.provider ?? base.provider;
  const model = override.model ?? base.model;
  const effort = override.effort ?? base.effort;
  return { provider, model, ...(effort !== undefined ? { effort } : {}) } as AiFlowSettings;
};

/**
 * Apply `extras.override` to the {@link Settings} record so the adapter rebuild and the per-flow launcher see the same
 * values. Implement is excluded — its roles go through `extras.implementRoleOverrides`.
 */
export const applyOverrideToSettings = (
  settings: Settings,
  flowId: string,
  override: LaunchExtras['override']
): Settings => {
  if (override === undefined) return settings;
  const aiFlow = aiFlowIdFor(flowId);
  if (aiFlow === undefined) return settings;
  // Implement uses implementRoleOverrides exclusively — the customize picker for implement
  // emits per-role overrides, not the single-row shape.
  if (flowId === 'implement') return settings;
  if (aiFlow === 'implement') {
    // review / detect-scripts / detect-skills aliases that read implement.generator.
    const merged = mergeRow(settings.ai.implement.generator, override);
    return {
      ...settings,
      ai: { ...settings.ai, implement: { ...settings.ai.implement, generator: merged } },
    };
  }
  return {
    ...settings,
    ai: { ...settings.ai, [aiFlow]: mergeRow(settings.ai[aiFlow], override) },
  };
};

const cwdFromSnapshot = (snapshot: AppStateSnapshot): AbsolutePath | undefined => {
  if (!snapshot.project) return undefined;
  const repo = snapshot.project.repositories[0];
  return repo?.path;
};

/**
 * Settings priority: caller-supplied snapshot > on-disk reload > boot-time snapshot, with the picker's per-launch
 * override applied on top.
 */
const resolveLaunchSettings = async (deps: LauncherDeps, flowId: string, extras: LaunchExtras): Promise<Settings> => {
  let baseSettings = extras.settingsSnapshot ?? deps.app.settings;
  if (extras.settingsSnapshot === undefined) {
    const reloaded = await deps.app.settingsRepo.load();
    if (reloaded.ok) baseSettings = reloaded.value;
  }
  return applyOverrideToSettings(baseSettings, flowId, extras.override);
};

/**
 * Rebuild the provider-bound adapters from the resolved settings every launch, keyed on the dispatched flow's id.
 */
const buildLaunchAdapters = (deps: LauncherDeps, flowId: string, settings: Settings) => {
  const aiFlow = aiFlowIdFor(flowId);
  const adapterFlow: FlowId = aiFlow ?? 'refine';
  const provider = createAiProvider({
    flow: adapterFlow,
    ai: settings.ai,
    harnessConfig: settings.harness,
    eventBus: deps.app.eventBus,
    childRegistry: deps.app.childRegistry,
    // Carry the wire-time spawn seam across the rebuild.
    ...(deps.app.providerSpawn !== undefined ? { spawn: deps.app.providerSpawn } : {}),
  });
  const interactiveAi = createInteractiveAiProvider({
    flow: adapterFlow,
    ai: settings.ai,
    eventBus: deps.app.eventBus,
  });
  const resolvedProvider = primaryFlowRow(settings.ai, adapterFlow).provider;
  const skillsAdapter = createSkillsAdapter({
    provider: resolvedProvider,
    logger: deps.app.logger,
  });
  const effort = aiFlow !== undefined ? resolveEffort(aiFlow, settings) : undefined;
  return { provider, interactiveAi, skillsAdapter, resolvedProvider, effort };
};

/** Build the four skill sources composed at launch — bundled, project, operator drop-in and phase — as a tuple. */
const buildSkillSourceQuad = (
  deps: SkillCompositionDeps,
  snapshot: Pick<AppStateSnapshot, 'project'>,
  resolvedProvider: AiProvider,
  warnIfContractViolated?: (skill: Skill) => void
): {
  readonly bundled: SkillSource;
  readonly project: SkillSource;
  readonly operator: SkillSource;
  readonly phase: SkillSource;
} => {
  const projectSource = createProjectSkillSource({ getProject: () => snapshot.project });
  const operatorSource = createOperatorSkillSource({
    operatorSkillsRoot: deps.storage.operatorSkillsRoot,
    provider: resolvedProvider,
    logger: deps.app.logger,
    ...(warnIfContractViolated !== undefined ? { warnIfContractViolated } : {}),
  });
  const phaseSource = createPhaseSkillSource({
    operatorSkillsRoot: deps.storage.operatorSkillsRoot,
    logger: deps.app.logger,
    ...(warnIfContractViolated !== undefined ? { warnIfContractViolated } : {}),
  });
  return { bundled: deps.app.skillSource, project: projectSource, operator: operatorSource, phase: phaseSource };
};

/**
 * Compose the four {@link buildSkillSourceQuad} sources into one union, then wrap it in the single skill-selection
 * resolution seam ({@link createResolvedSkillSource}).
 * @public
 */
export const buildComposedSkillSource = (
  deps: SkillCompositionDeps,
  snapshot: Pick<AppStateSnapshot, 'project'>,
  resolvedProvider: AiProvider,
  flowId: string,
  settings: Settings,
  extras: LaunchExtras
): SkillSource => {
  const warnIfContractViolated = (skill: Skill): void => {
    // Contract scanner runs as a WARNING only — a violating skill is logged and still installed (the operator owns
    // their skills).
    checkContract(deps.app.logger, skill.name, skill.content);
  };
  const { bundled, project, operator, phase } = buildSkillSourceQuad(
    deps,
    snapshot,
    resolvedProvider,
    warnIfContractViolated
  );
  const composed = composeSkillSources(bundled, project, operator, phase);

  // Run-scoped disabled set, resolved ONCE: the per-run override REPLACES the durable row when present (run wins over
  // remembered).
  const settingsFlow = aiFlowIdFor(flowId);
  const savedDisabled = settingsFlow !== undefined ? (settings.ai.skills?.[settingsFlow]?.disabled ?? []) : [];
  const runDisabled = extras.skillsOverride !== undefined ? extras.skillsOverride.disabled : savedDisabled;
  return createResolvedSkillSource({ inner: composed, flowDisabled: () => runDisabled });
};

/** One skill the customize picker's skills step can offer to disable, tagged with where it comes from. */
export interface SkillCandidate {
  readonly name: string;
  readonly description: string;
  readonly origin: 'bundled-default' | 'phase-folder' | 'project' | 'operator';
}

/** Result of {@link buildSkillCandidates} — the picker's skills-step input. */
export interface SkillCandidatesResult {
  /** The settings-row `FlowId` a "remember" save would target — absent when the step is skipped. */
  readonly settingsFlow?: FlowId;
  readonly candidates: readonly SkillCandidate[];
  /** Names in the durable `settings.ai.skills[flow].disabled` row, before any per-run change. */
  readonly savedDisabled: readonly string[];
  /** At least one source's listing FAILED, so `candidates` is incomplete. */
  readonly degraded: boolean;
}

/**
 * Pre-subtraction candidate list for a flow's skills customize step.
 * @public
 */
export const buildSkillCandidates = async (
  deps: SkillCompositionDeps,
  snapshot: Pick<AppStateSnapshot, 'project'>,
  flowId: string,
  settings: Settings,
  providerOverride?: AiProvider
): Promise<SkillCandidatesResult> => {
  const aiFlow = aiFlowIdFor(flowId);
  if (aiFlow === undefined || !flowMountsSkills(flowId)) {
    return { candidates: [], savedDisabled: [], degraded: false };
  }

  // Operator skills are provider-scoped; the picker re-fetches with the row walk's overridden
  // provider so the checklist matches what the run would actually install.
  const resolvedProvider = providerOverride ?? primaryFlowRow(settings.ai, aiFlow).provider;
  const { bundled, project, operator, phase } = buildSkillSourceQuad(deps, snapshot, resolvedProvider);

  // A failed listing degrades the whole result instead of silently narrowing it: the bundled source hard-fails on one
  // unreadable SKILL.md.
  let degraded = false;
  const tagged = async (source: SkillSource, origin: SkillCandidate['origin']): Promise<readonly SkillCandidate[]> => {
    const r = await source.getForFlow(aiFlow);
    if (!r.ok) {
      degraded = true;
      deps.app.logger.warn(`skills checklist: ${origin} listing failed — ${r.error.message}`);
      return [];
    }
    return r.value.map((skill) => ({ name: skill.name, description: skill.description, origin }));
  };

  const merged = [
    ...(await tagged(bundled, 'bundled-default')),
    ...(await tagged(project, 'project')),
    ...(await tagged(operator, 'operator')),
    ...(await tagged(phase, 'phase-folder')),
  ];
  // Last-wins by name, mirroring the resolution seam's dedupe (`resolve-selection.ts`) so a
  // phase-folder / operator copy of a bundled name shows its ACTUAL shadowing origin.
  const lastIndexByName = new Map<string, number>();
  merged.forEach((c, i) => lastIndexByName.set(c.name, i));
  const candidates = merged.filter((c, i) => lastIndexByName.get(c.name) === i);

  const savedDisabled = settings.ai.skills?.[aiFlow]?.disabled ?? [];
  return { settingsFlow: aiFlow, candidates, savedDisabled, degraded };
};

/**
 * Pin the launch snapshot's project / sprint onto a successful dispatch result. create-sprint never pins the snapshot
 * sprint: the run's sprint does not exist at launch time.
 */
const pinLaunchResult = (dispatchResult: LaunchResult, snapshot: AppStateSnapshot, flowId: string): LaunchResult => {
  if (!dispatchResult.ok) return dispatchResult;
  return {
    ...dispatchResult,
    ...(snapshot.project !== undefined
      ? { pinnedProjectId: snapshot.project.id, pinnedProjectLabel: snapshot.project.displayName }
      : {}),
    ...(snapshot.sprint !== undefined && flowId !== 'create-sprint'
      ? { pinnedSprintId: snapshot.sprint.id, pinnedSprintLabel: snapshot.sprint.name }
      : {}),
  };
};

export const launchFlow = async (
  deps: LauncherDeps,
  flowId: string,
  snapshot: AppStateSnapshot,
  extras: LaunchExtras = {}
): Promise<LaunchResult> => {
  const settings = await resolveLaunchSettings(deps, flowId, extras);
  const { provider, interactiveAi, skillsAdapter, resolvedProvider, effort } = buildLaunchAdapters(
    deps,
    flowId,
    settings
  );
  const composedSkillSource = buildComposedSkillSource(deps, snapshot, resolvedProvider, flowId, settings, extras);

  // Every launched runner gets bridged to the event bus so subscribers (TUI panels, progress files, future webhooks)
  // see chain progress without per-flow emission wiring.
  const bridge = <T>(runner: Runner<T>): Runner<T> => {
    bridgeRunnerToEventBus(runner as Runner<unknown>, deps.app.eventBus, {
      flowId,
      clock: deps.app.clock,
    });
    return runner;
  };

  const ctx: LaunchContext = {
    deps,
    snapshot,
    extras,
    settings,
    provider,
    interactiveAi,
    skillsAdapter,
    skillSource: composedSkillSource,
    cwd: cwdFromSnapshot(snapshot),
    sessionId,
    bridge,
    ...(effort !== undefined ? { effort } : {}),
  };

  const dispatchResult = await (async (): Promise<LaunchResult> => {
    switch (flowId) {
      case 'create-sprint':
        return launchCreateSprint(ctx);
      case 'refine':
        return launchRefine(ctx);
      case 'plan':
        return launchPlan(ctx);
      case 'implement':
        return launchImplement(ctx);
      case 'review':
        return launchReview(ctx);
      case 'close-sprint':
        return launchCloseSprint(ctx);
      case 'readiness':
        return launchReadiness(ctx);
      case 'detect-skills':
        return launchDetectSkills(ctx);
      case 'detect-scripts':
        return launchDetectScripts(ctx);
      case 'ideate':
        return launchIdeate(ctx);
      default:
        return { ok: false, reason: `Unknown flow: ${flowId}` };
    }
  })();

  return pinLaunchResult(dispatchResult, snapshot, flowId);
};
