/**
 * Bridges flow manifests → live `Element` instances. {@link launchFlow} resolves cross-cutting
 * inputs (fresh settings, runner→event-bus bridge, composed skill source) and dispatches to a
 * per-flow `launch<X>` function under `./launch/`. Provider-bound adapters
 * (`HeadlessAiProvider`, `InteractiveAiProvider`, `SkillsAdapter`) are rebuilt per launch
 * keyed on the dispatched flow's id — so refine running on Claude while implement runs on
 * Codex composes cleanly without per-flow assumption about a single boot-time provider.
 *
 * Returning a `LaunchResult` instead of throwing keeps error surfaces explicit; the UI can show
 * "missing project / sprint / cwd" without a try/catch dance.
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
import { warnIfContractViolated as checkContract } from '@src/integration/ai/skills/_engine/skill-contract-checker.ts';
import { type AiFlowSettings, type AiProvider, primaryFlowRow, type Settings } from '@src/domain/entity/settings.ts';
import type { FlowId } from '@src/domain/value/flow-id.ts';
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
      /**
       * Optional `taskId → displayName` map for runs that operate on a fixed task set. The TUI's
       * Tasks panel substitutes these so per-task blocks show the sprint's task name instead of
       * the raw uuid prefix. Currently populated only by the Implement launcher.
       */
      readonly taskNames?: ReadonlyMap<string, string>;
      /** Configured `maxTurns` for the run's gen-eval loop, surfaced as `round N/M` in the panel. */
      readonly maxTurns?: number;
      /** Configured `maxAttempts` per task, surfaced as the `/X` in `attempt N/X` in the panel. */
      readonly maxAttempts?: number;
      /**
       * Static element-tree leaf names in DFS order, computed at chain-construction time via
       * {@link flattenLeaves}. Drives the TUI's Flow-steps panel to render *all expected* steps
       * upfront (pending → running → done) instead of only the entries that have already traced.
       */
      readonly plannedLeaves?: readonly string[];
      /**
       * Display label per planned leaf name (keyed by element `name`). Used by the Flow-steps
       * panel so pending / running rows render the friendly label instead of falling back to
       * the raw name (which embeds the absolute path for per-repo leaves). Once a leaf
       * executes, the trace entry's own label takes over.
       */
      readonly planLabelByName?: ReadonlyMap<string, string>;
      /**
       * Name of the per-task subchain's final leaf — when this name (with the task uuid suffix
       * stripped) appears in the trace for a task, the UI flips that task to `completed`.
       * Threaded so a flow that renames its terminal leaf doesn't silently leave tasks stuck on
       * `running` forever.
       */
      readonly terminalSubstepName?: string;
      /**
       * Map of `taskId → RecoveryContext` for tasks the launcher detected as resuming a prior
       * aborted attempt. Forwarded into `SessionDescriptor.taskRecovering`; the execute view
       * renders a one-line resume banner under the active-task header. Empty / undefined when
       * no task is resuming.
       */
      readonly taskRecovering?: ReadonlyMap<string, RecoveryContext>;
      /**
       * Implement-flow gen-eval models, projected onto the SessionDescriptor so the execute
       * view can render `<gen-model> → <eval-model> (eval)` on the active-attempt rail when the
       * two roles point at different models — collapsed to a single model name when they
       * match. Only the implement launcher sets these; every other flow leaves them undefined
       * and the rail falls back to the existing single-model display path.
       */
      readonly generatorModel?: string;
      readonly evaluatorModel?: string;
      /**
       * Resolved effort strings for each implement role (`low|medium|high|xhigh|max`). Displayed
       * alongside the model name in the HeaderCard so the operator can see the effort at a glance.
       * Only the implement launcher sets these; every other flow leaves them undefined.
       */
      readonly generatorEffort?: string;
      readonly evaluatorEffort?: string;
      /**
       * Project and sprint the run was launched against, pinned at launch time for the run's
       * lifetime. Populated from the launch snapshot so every flow launched against a sprint
       * pins it; flows started without a sprint (e.g. create-sprint) leave the sprint fields
       * unset.
       */
      readonly pinnedProjectId?: ProjectId;
      readonly pinnedProjectLabel?: string;
      readonly pinnedSprintId?: SprintId;
      readonly pinnedSprintLabel?: string;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * Optional per-launch overrides supplied by the caller. `repositoryId` skips the in-flow pick
 * prompt (used when launching from a focused repo row on the project-detail view or when the
 * TUI's session-scoped repo pin has been set). `override` swaps the settings-default
 * provider / model / effort for one launch — flows-view's pre-launch customize picker writes
 * here when the user picks different values than the configured defaults. Each field is
 * independently optional: an unset field falls back to the matching `settings.ai[flow]` slot.
 *
 * `settingsSnapshot` lets the caller pass a freshly-loaded {@link Settings} record (e.g. the
 * TUI re-reads via `settingsRepo.load()` at click-time so provider/model changes in the
 * Settings view propagate without a full restart). When unset, the launcher falls back to the
 * boot-time `app.settings` snapshot, which is fine for CLI-shot callers that don't long-poll.
 */
export interface LaunchExtras {
  readonly repositoryId?: RepositoryId;
  /**
   * Per-launch single-row override (refine / plan / readiness / ideate plus the implement-
   * generator-driven flows review / detect-scripts / detect-skills). Each field is independent
   * — supplying only `provider` keeps the persisted model / effort for fields not named. The
   * implement flow itself does NOT consume this; it reads {@link implementRoleOverrides}
   * instead because its two roles each carry their own row.
   */
  readonly override?: {
    readonly provider?: AiProvider;
    readonly model?: string;
    readonly effort?: string;
  };
  /** Freshly-loaded settings snapshot; overrides the stale `app.settings` boot snapshot. */
  readonly settingsSnapshot?: Settings;
  /**
   * Per-launch implement-role overrides — supplied either by the bare-`ralphctl` CLI flags
   * (`--implement-generator-provider`, `--implement-generator-model`,
   * `--implement-evaluator-provider`, `--implement-evaluator-model`) or by the TUI's
   * pre-launch customize picker. Each role accepts `{ provider?, model?, effort? }` with
   * every field independently optional — a role override that only carries `provider` keeps
   * the persisted model / effort for that role. Roles are independent — overriding only
   * generator leaves evaluator on its persisted settings row.
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
}

export interface LauncherDeps {
  readonly app: AppDeps;
  readonly interactive: InteractivePrompt;
  readonly storage: StoragePaths;
  /**
   * Pause-the-host helper for interactive AI sessions (refine, plan-interactive). Threaded
   * by `launchTui` from the live Ink instance; tests pass a passthrough.
   */
  readonly runInTerminal: RunInTerminal;
}

const sessionId = (): string => `r-${Math.random().toString(36).slice(2, 10)}-${String(Date.now())}`;

/**
 * Project the optional UI-hint fields from a successful {@link LaunchResult} into the shape
 * `SessionManager.register` accepts. Centralised so the four call sites (flows-view,
 * pick-sprint-view, project-detail-view, sprints-view) don't each stamp the same
 * conditional-spread pattern. Adding a new UI hint becomes one edit here instead of four.
 */
export const sessionHintsFromLaunchResult = (
  result: Extract<LaunchResult, { readonly ok: true }>
): {
  readonly taskNames?: ReadonlyMap<string, string>;
  readonly maxTurns?: number;
  readonly maxAttempts?: number;
  readonly plannedLeaves?: readonly string[];
  readonly planLabelByName?: ReadonlyMap<string, string>;
  readonly terminalSubstepName?: string;
  readonly taskRecovering?: ReadonlyMap<string, RecoveryContext>;
  readonly generatorModel?: string;
  readonly evaluatorModel?: string;
  readonly generatorEffort?: string;
  readonly evaluatorEffort?: string;
  readonly pinnedProjectId?: ProjectId;
  readonly pinnedProjectLabel?: string;
  readonly pinnedSprintId?: SprintId;
  readonly pinnedSprintLabel?: string;
} => ({
  ...(result.taskNames !== undefined ? { taskNames: result.taskNames } : {}),
  ...(result.maxTurns !== undefined ? { maxTurns: result.maxTurns } : {}),
  ...(result.maxAttempts !== undefined ? { maxAttempts: result.maxAttempts } : {}),
  ...(result.plannedLeaves !== undefined ? { plannedLeaves: result.plannedLeaves } : {}),
  ...(result.planLabelByName !== undefined ? { planLabelByName: result.planLabelByName } : {}),
  ...(result.terminalSubstepName !== undefined ? { terminalSubstepName: result.terminalSubstepName } : {}),
  ...(result.taskRecovering !== undefined ? { taskRecovering: result.taskRecovering } : {}),
  ...(result.generatorModel !== undefined ? { generatorModel: result.generatorModel } : {}),
  ...(result.evaluatorModel !== undefined ? { evaluatorModel: result.evaluatorModel } : {}),
  ...(result.generatorEffort !== undefined ? { generatorEffort: result.generatorEffort } : {}),
  ...(result.evaluatorEffort !== undefined ? { evaluatorEffort: result.evaluatorEffort } : {}),
  ...(result.pinnedProjectId !== undefined ? { pinnedProjectId: result.pinnedProjectId } : {}),
  ...(result.pinnedProjectLabel !== undefined ? { pinnedProjectLabel: result.pinnedProjectLabel } : {}),
  ...(result.pinnedSprintId !== undefined ? { pinnedSprintId: result.pinnedSprintId } : {}),
  ...(result.pinnedSprintLabel !== undefined ? { pinnedSprintLabel: result.pinnedSprintLabel } : {}),
});

/**
 * Map a launcher flow id to the {@link FlowId} that owns the AI session, or `undefined` for
 * flows that don't open one. `detect-scripts` and `detect-skills` are read-only inventory
 * round-trips that reuse the `readiness` row's provider / model / effort — they don't have
 * their own settings entry. `review` reuses the `implement` row — same code-mutation profile,
 * and matching the model already read from `settings.ai.implement.generator.model` in
 * launch/review.ts keeps the per-launch provider rebuild aligned with the model that gets
 * passed to the spawn.
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
      // The kebab-case orchestration id maps to its camelCase settings row. `create-pr` only
      // spawns an AI session when AI authoring is on; when it does, the createPr row drives the
      // provider / model / effort the spawn uses.
      return 'createPr';
    default:
      return undefined;
  }
};

/**
 * Per-field merge of `override` onto an `AiFlowSettings` row. Each field of the override is
 * independent — supplying only `provider` keeps the row's persisted model / effort. The
 * resulting row is cast to {@link AiFlowSettings} because TypeScript can't narrow the
 * discriminated union from a dynamic provider key; the picker only ever assembles coherent
 * overrides (a provider switch always rides with a fresh model from the new provider's
 * catalog) so the cast remains sound.
 */
const mergeRow = (base: AiFlowSettings, override: NonNullable<LaunchExtras['override']>): AiFlowSettings => {
  const provider = override.provider ?? base.provider;
  const model = override.model ?? base.model;
  const effort = override.effort ?? base.effort;
  return { provider, model, ...(effort !== undefined ? { effort } : {}) } as AiFlowSettings;
};

/**
 * Apply `extras.override` to the {@link Settings} record so the launcher's adapter rebuild
 * (provider, interactiveAi, skillsAdapter) and the per-flow launcher's row read both see the
 * same overridden values. Implement is excluded — its two roles are addressed through
 * `extras.implementRoleOverrides` exclusively; `extras.override` on an implement launch is a
 * caller bug we silently ignore here so the merge stays single-row.
 *
 * For review (and any other flow that aliases another flow's row via {@link aiFlowIdFor}),
 * the override applies to the aliased row. Review uses `ai.implement.generator`; an override
 * at review-launch time rewrites generator only — evaluator is untouched.
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
    // review / detect-scripts / detect-skills aliases that read implement.generator. The
    // launcher's primary-row helper resolves implement → generator, so we override the
    // generator slot only.
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

export const launchFlow = async (
  deps: LauncherDeps,
  flowId: string,
  snapshot: AppStateSnapshot,
  extras: LaunchExtras = {}
): Promise<LaunchResult> => {
  // Settings priority: caller-supplied snapshot > on-disk reload > boot-time snapshot. The
  // boot-time `app.settings` is the floor; it's stale across any Settings-view edit, and the
  // adapter-rebuild block below depends on the per-flow row's provider matching the user's
  // current choice. Callers that already reloaded (e.g. flows-view, for its model picker) just
  // pass their fresh snapshot via `extras.settingsSnapshot`; callers that didn't (project-
  // detail-view) implicitly opt into a one-roundtrip reload here so they don't have to remember.
  let baseSettings = extras.settingsSnapshot ?? deps.app.settings;
  if (extras.settingsSnapshot === undefined) {
    const reloaded = await deps.app.settingsRepo.load();
    if (reloaded.ok) baseSettings = reloaded.value;
  }
  // Apply the picker's per-launch override BEFORE constructing adapters / resolving effort so
  // a provider override re-keys the adapter rebuild below. Implement is handled inside its
  // launcher because its two roles need independent merges; for every other AI flow the
  // override applies to the single row identified by aiFlowIdFor (review and detect-* aliases
  // included).
  const settings = applyOverrideToSettings(baseSettings, flowId, extras.override);

  // Rebuild the provider-bound adapters from the fresh settings every launch, keyed on the
  // dispatched flow's id. `app.provider`, `app.interactiveAi`, and `app.skillsAdapter` are
  // wired once at `wire()` time from a placeholder flow (see `wire.ts`); without this rebuild,
  // a user who configured refine on Claude and implement on Codex would get whichever provider
  // happened to seed wire(). These factories are tiny (no I/O, no async) so a per-launch
  // rebuild is essentially free. Flows that don't open an AI session fall through to whatever
  // wire() seeded — they never call `.generate(...)`.
  const aiFlow = aiFlowIdFor(flowId);
  const adapterFlow: FlowId = aiFlow ?? 'refine';
  const provider = createAiProvider({
    flow: adapterFlow,
    ai: settings.ai,
    harnessConfig: settings.harness,
    eventBus: deps.app.eventBus,
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

  // Compose the static bundled skill source with a project-scoped source that emits per-repo
  // setup / verify skills authored via the detect-skills flow. The project-source closure reads
  // through `snapshot.project` so every install-skills leaf during this chain run sees the latest
  // skills as of launch time. Flows that run without a project (none today) fall back cleanly
  // to bundled-only.
  const projectSource = createProjectSkillSource({ getProject: () => snapshot.project });
  // Global, provider-specific operator drop-in skills under `<appRoot>/skills/<providerDir>/`.
  // Keyed on the resolved provider so a mixed config installs each flow's operator skills for
  // that flow's provider only. Installed through the same adapter as bundled — same `ralphctl-`
  // namespace + `.git/info/exclude` wildcard + tracked uninstall. A missing dir = empty source.
  const operatorSource = createOperatorSkillSource({
    operatorSkillsRoot: deps.storage.operatorSkillsRoot,
    provider: resolvedProvider,
    logger: deps.app.logger,
    // Operator skills run the harness-compatibility scanner as a WARNING only — a violating
    // skill is logged and still installed (the operator owns their skills). Adapt the checker's
    // (logger, name, content) signature to the source's `(skill) => void` warner shape.
    warnIfContractViolated: (skill) => {
      checkContract(deps.app.logger, skill.name, skill.content);
    },
  });
  const composedSkillSource = composeSkillSources(deps.app.skillSource, projectSource, operatorSource);

  // Every launched runner gets bridged to the event bus so subscribers (TUI panels,
  // progress files, future webhooks) see chain progress without per-flow emission wiring. The
  // bridge lifecycle ties to the runner's — terminal state stops emission.
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

  if (!dispatchResult.ok) return dispatchResult;

  return {
    ...dispatchResult,
    ...(snapshot.project !== undefined
      ? { pinnedProjectId: snapshot.project.id, pinnedProjectLabel: snapshot.project.displayName }
      : {}),
    // create-sprint never pins the snapshot sprint: the run's sprint does not exist at launch
    // time, so a sprint on the snapshot is by definition the PREVIOUS selection — pinning it
    // would mislabel the run's execute view / breadcrumb. The sprint-bound launch wrapper pins
    // the real one via `setPinnedSprint` once the chain resolves it.
    ...(snapshot.sprint !== undefined && flowId !== 'create-sprint'
      ? { pinnedSprintId: snapshot.sprint.id, pinnedSprintLabel: snapshot.sprint.name }
      : {}),
  };
};
