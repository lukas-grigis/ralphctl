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
       * Provider id backing each implement role (`claude-code` / `github-copilot` / `openai-codex`),
       * rendered dim before the model name in the HeaderCard so the operator can see which backend
       * each role runs on. Only the implement launcher sets these; every other flow leaves them
       * undefined and the HeaderCard omits the provider segment.
       */
      readonly generatorProvider?: AiProvider;
      readonly evaluatorProvider?: AiProvider;
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
  /**
   * Per-run skill opt-out, supplied by the TUI customize picker's skills step. When present its
   * `disabled` names REPLACE the durable `settings.ai.skills[flow].disabled` preference for this
   * launch — a run override wins outright rather than unioning with the saved list, so a per-run
   * RE-ENABLE of a remembered-off skill is possible (pick nothing to disable this run and every
   * saved opt-out is lifted for the duration of the run). Subtraction is by exact install name,
   * so it applies to ANY skill — bundled, project, operator, or phase-folder. Absent = no run
   * override; the launcher then resolves against the saved preference alone. Consumed only at the
   * single resolution seam in `buildComposedSkillSource` ({@link createResolvedSkillSource}).
   */
  readonly skillsOverride?: { readonly disabled: readonly string[] };
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

/**
 * The subset of {@link LauncherDeps} that skill-source composition actually reads — narrower
 * than the full bag so a caller with no `InteractivePrompt` / `RunInTerminal` (a one-shot CLI
 * command, or a TUI view that never pauses the host) can compose a skill source without
 * inventing ports it never uses. A full `LauncherDeps` object still satisfies this structurally.
 *
 * @public
 */
export type SkillCompositionDeps = Pick<LauncherDeps, 'app' | 'storage'>;

const sessionId = (): string => `r-${Math.random().toString(36).slice(2, 10)}-${String(Date.now())}`;

/** The `ok: true` branch of {@link LaunchResult} — the shape {@link sessionHintsFromLaunchResult} reads. */
type LaunchOk = Extract<LaunchResult, { readonly ok: true }>;

/**
 * Optional UI-hint field names projected by {@link sessionHintsFromLaunchResult}. Declared once
 * as a `satisfies`-checked tuple so adding a new hint is a one-line edit that stays in sync with
 * both the picker call and its inferred return type.
 */
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
 * Project the optional UI-hint fields from a successful {@link LaunchResult} into the shape
 * `SessionManager.register` accepts. Centralised so the four call sites (flows-view,
 * pick-sprint-view, project-detail-view, sprints-view) don't each stamp the same
 * conditional-spread pattern. Adding a new UI hint becomes one edit to {@link HINT_KEYS} instead
 * of four.
 */
export const sessionHintsFromLaunchResult = (result: LaunchOk): Pick<LaunchOk, (typeof HINT_KEYS)[number]> =>
  pickDefined(result, HINT_KEYS);

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
 * Flows whose AI session actually gets a composed skill source installed — the only flows
 * where a per-run skills customization has any effect. `review` / `detect-scripts` /
 * `detect-skills` reuse another flow's AI row via {@link aiFlowIdFor} but their own launchers
 * never read `ctx.skillSource`, so a skills override for them would silently no-op.
 *
 * `create-pr` mounts skills too, but never reaches `launchFlow`'s dispatch switch — it's routed
 * to its own view (`create-pr-view.tsx`) and its own CLI command, each calling
 * {@link buildComposedSkillSource} directly around the `generate-pr-content` leaf. It therefore
 * has no customize-picker skills step (no per-run checklist / opt-out UI); it always installs
 * the settings/registry-resolved default set for the `createPr` row.
 *
 * The customize picker's skills step is skipped entirely for a flow this returns `false` for,
 * rather than presenting a checklist that wouldn't do anything.
 *
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
 * Every {@link FlowId} whose launch context actually mounts a skill source, derived from
 * {@link flowMountsSkills} (the single source of truth) keyed back to `FlowId` via
 * {@link PHASE_FLOW_DIR}. Shared by the TUI skill catalog (row chips — see
 * `ui/tui/views/skills-view-internals/flow-visual.ts`) and `ralphctl skills list` (the
 * "enabled flows" column) so the two surfaces can never drift on which flows a skill can
 * actually load into.
 *
 * @public
 */
export const SKILL_MOUNTING_FLOW_IDS: readonly FlowId[] = FLOW_IDS.filter((flowId) =>
  flowMountsSkills(PHASE_FLOW_DIR[flowId])
);

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

/**
 * Settings priority: caller-supplied snapshot > on-disk reload > boot-time snapshot, with the
 * picker's per-launch override applied on top. The boot-time `app.settings` is the floor; it's
 * stale across any Settings-view edit, and the adapter-rebuild in {@link buildLaunchAdapters}
 * depends on the per-flow row's provider matching the user's current choice. Callers that
 * already reloaded (e.g. flows-view, for its model picker) just pass their fresh snapshot via
 * `extras.settingsSnapshot`; callers that didn't (project-detail-view) implicitly opt into a
 * one-roundtrip reload here so they don't have to remember.
 *
 * The override is applied BEFORE the adapter rebuild so a provider override re-keys it. Implement
 * is handled inside its own launcher because its two roles need independent merges; for every
 * other AI flow the override applies to the single row identified by `aiFlowIdFor` (review and
 * detect-* aliases included).
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
 * Rebuild the provider-bound adapters from the resolved settings every launch, keyed on the
 * dispatched flow's id. `app.provider`, `app.interactiveAi`, and `app.skillsAdapter` are wired
 * once at `wire()` time from a placeholder flow (see `wire.ts`); without this rebuild, a user who
 * configured refine on Claude and implement on Codex would get whichever provider happened to
 * seed wire(). These factories are tiny (no I/O, no async) so a per-launch rebuild is essentially
 * free. Flows that don't open an AI session fall through to whatever wire() seeded — they never
 * call `.generate(...)`.
 */
const buildLaunchAdapters = (deps: LauncherDeps, flowId: string, settings: Settings) => {
  const aiFlow = aiFlowIdFor(flowId);
  const adapterFlow: FlowId = aiFlow ?? 'refine';
  const provider = createAiProvider({
    flow: adapterFlow,
    ai: settings.ai,
    harnessConfig: settings.harness,
    eventBus: deps.app.eventBus,
    // Carry the wire-time spawn seam across the rebuild. Without it a scripted / faked spawn
    // reaches `app.provider` and is then dropped here, so the launch spawns the real CLI —
    // see `AppDeps.providerSpawn`.
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

/**
 * Build the four skill sources composed at launch — the app-wired bundled source, a
 * project-scoped source that emits per-repo setup / verify skills authored via the detect-skills
 * flow, the global provider-specific operator drop-in source under
 * `<appRoot>/skills/<providerDir>/`, and the provider-agnostic phase (opt-in) source under
 * `<appRoot>/skills/<flowDir>/`. Returned as a tuple, NOT composed — {@link buildComposedSkillSource}
 * unions them for a real launch; {@link buildSkillCandidates} tags each one's contribution with
 * its origin for the customize picker's skills step, which needs to know WHICH source a
 * candidate came from rather than a flattened union.
 *
 * The project source's closure reads through `snapshot.project` so every caller sees the latest
 * skills as of call time; a project-less snapshot falls back cleanly to an empty project source.
 * The operator source is keyed on `resolvedProvider` so a mixed config only sees that flow's
 * provider's drop-in folder; a missing dir yields an empty source. The phase source is
 * provider-agnostic and shares the SAME `operatorSkillsRoot` + logger as the operator source; a
 * missing flow dir is likewise an empty source.
 *
 * `warnIfContractViolated` is optional and shared across the operator + phase sources — the real
 * launch composition wires the WARNING-only contract check; the read-only candidate listing
 * passes nothing (listing a skill isn't installing it, so the check stays reserved for the
 * source that actually gets installed).
 */
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
 * Compose the four {@link buildSkillSourceQuad} sources into one union, then wrap it in the
 * single skill-selection resolution seam ({@link createResolvedSkillSource}).
 *
 * Composition ORDER is load-bearing: bundled → project → operator → phase, because the resolving
 * decorator's dedupe keeps the LAST occurrence of a name, so a phase-folder copy of a bundled
 * skill (the catalog's copy-on-enable path) shadows the bundled default.
 *
 * The resolving decorator is the ONE place skill selection is filtered — no leaf / adapter
 * filters. `flowDisabled` is run-scoped: when the per-run `extras.skillsOverride` is present, its
 * `disabled` names REPLACE the durable opt-out preference outright — a run override wins over the
 * saved preference rather than unioning with it, so picking nothing to disable for a run
 * RE-ENABLES every remembered-off skill for that run's duration. Absent an override, the durable
 * row applies: the dispatched flow's settings id via {@link aiFlowIdFor} (createPr camel; review
 * → implement; detect-* → readiness — the single aliasing rule everywhere). With no saved row, no
 * override, and empty phase folders the decorator is a byte-for-byte no-op, preserving today's
 * skill set and order.
 *
 * Exported for the launcher composition fence test (zero-config no-op + opt-out subtraction +
 * aliased-flow row inheritance) — it is the one place skill selection is resolved, so testing it
 * directly beats reconstructing the wiring, which could drift from the real launcher.
 *
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
    // Contract scanner runs as a WARNING only — a violating skill is logged and still installed
    // (the operator owns their skills). Adapt the checker's (logger, name, content) signature to
    // the source's `(skill) => void` warner shape. Shared by the operator + phase sources.
    checkContract(deps.app.logger, skill.name, skill.content);
  };
  const { bundled, project, operator, phase } = buildSkillSourceQuad(
    deps,
    snapshot,
    resolvedProvider,
    warnIfContractViolated
  );
  const composed = composeSkillSources(bundled, project, operator, phase);

  // Run-scoped disabled set, resolved ONCE: the per-run override REPLACES the durable row when
  // present (run wins over remembered); otherwise the dispatched flow's durable settings row
  // applies (via the shared aiFlowIdFor aliasing). Flows with no AI row contribute no saved names.
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
  /**
   * At least one source's listing FAILED, so `candidates` is incomplete. The caller must not
   * show a checklist built from it (an unchecked-set complement over a partial list reads as
   * "disable everything missing") and must never persist a "remember" choice computed from it —
   * `flows-view.tsx` skips the skills step outright when this is set.
   */
  readonly degraded: boolean;
}

/**
 * Pre-subtraction candidate list for a flow's skills customize step — the same four-source union
 * {@link buildComposedSkillSource} composes (bundled → project → operator → phase, LAST wins on a
 * name collision), each entry tagged with its origin so the picker can show why it's there. Unlike
 * the real launch composition, nothing is subtracted here — the caller (the picker) decides
 * checked/unchecked from `savedDisabled`.
 *
 * Returns `{ candidates: [], savedDisabled: [] }` for a flow with no AI row ({@link aiFlowIdFor}
 * `undefined`) or one that doesn't actually mount a `skillSource` ({@link flowMountsSkills}
 * `false`) — the caller uses this to skip the skills step entirely rather than show a checklist
 * that would have no effect on the launch.
 *
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

  // A failed listing degrades the whole result instead of silently narrowing it: the bundled
  // source hard-fails on one unreadable SKILL.md, and a checklist missing every bundled default
  // would let a "remember" save erase the operator's saved opt-outs over a transient read error.
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
 * Pin the launch snapshot's project / sprint onto a successful dispatch result. create-sprint
 * never pins the snapshot sprint: the run's sprint does not exist at launch time, so a sprint on
 * the snapshot is by definition the PREVIOUS selection — pinning it would mislabel the run's
 * execute view / breadcrumb. The sprint-bound launch wrapper pins the real one via
 * `setPinnedSprint` once the chain resolves it.
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

  return pinLaunchResult(dispatchResult, snapshot, flowId);
};
