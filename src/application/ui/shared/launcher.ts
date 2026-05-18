/**
 * Bridges flow manifests → live `Element` instances. {@link launchFlow} resolves cross-cutting
 * inputs (fresh settings, provider-bound adapters, composed skill source, runner→event-bus
 * bridge) and dispatches to a per-flow `launch<X>` function under `./launch/`.
 *
 * Returning a `LaunchResult` instead of throwing keeps error surfaces explicit; the UI can show
 * "missing project / sprint / cwd" without a try/catch dance.
 */

import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { StoragePaths } from '@src/application/bootstrap/storage-paths.ts';
import type { Runner } from '@src/application/chain/run/runner.ts';
import { bridgeRunnerToEventBus } from '@src/application/observability/chain-runner-bridge.ts';
import { createAiProvider } from '@src/application/bootstrap/provider-factory.ts';
import { createInteractiveAiProvider } from '@src/application/bootstrap/interactive-provider-factory.ts';
import { createSkillsAdapter } from '@src/integration/ai/skills/adapter-factory.ts';
import type { InteractivePrompt } from '@src/business/interactive/prompt.ts';
import { CLAUDE_MODELS } from '@src/domain/value/settings-models/claude.ts';
import { COPILOT_MODELS } from '@src/domain/value/settings-models/copilot.ts';
import { CODEX_MODELS } from '@src/domain/value/settings-models/codex.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { AppStateSnapshot } from '@src/application/ui/shared/state-snapshot.ts';
import type { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import { composeSkillSources, createProjectSkillSource } from '@src/integration/ai/skills/project/source.ts';
import type { Settings } from '@src/domain/entity/settings.ts';
import type { RunInTerminal } from '@src/application/ui/shared/run-in-terminal.ts';
import type { LaunchContext } from '@src/application/ui/shared/launch/context.ts';
import { launchCreateSprint } from '@src/application/ui/shared/launch/create-sprint.ts';
import { launchAddTickets } from '@src/application/ui/shared/launch/add-tickets.ts';
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
      /**
       * Static element-tree leaf names in DFS order, computed at chain-construction time via
       * {@link flattenLeaves}. Drives the TUI's Flow-steps panel to render *all expected* steps
       * upfront (pending → running → done) instead of only the entries that have already traced.
       */
      readonly plannedLeaves?: readonly string[];
      /**
       * Name of the per-task subchain's final leaf — when this name (with the task uuid suffix
       * stripped) appears in the trace for a task, the UI flips that task to `completed`.
       * Threaded so a flow that renames its terminal leaf doesn't silently leave tasks stuck on
       * `running` forever.
       */
      readonly terminalSubstepName?: string;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * Optional per-launch overrides supplied by the caller. `repositoryId` skips the in-flow pick
 * prompt (used when launching from a focused repo row on the project-detail view or when the
 * TUI's session-scoped repo pin has been set). `modelOverride` replaces the settings-default
 * model for one launch — flows-view's pre-launch picker writes here when the user picks a
 * different model than the configured default.
 *
 * `settingsSnapshot` lets the caller pass a freshly-loaded {@link Settings} record (e.g. the
 * TUI re-reads via `settingsRepo.load()` at click-time so provider/model changes in the
 * Settings view propagate without a full restart). When unset, the launcher falls back to the
 * boot-time `app.settings` snapshot, which is fine for CLI-shot callers that don't long-poll.
 */
export interface LaunchExtras {
  readonly repositoryId?: RepositoryId;
  /** Per-launch model override; falls back to `settings.ai.models.<flow>` when undefined. */
  readonly modelOverride?: string;
  /** Freshly-loaded settings snapshot; overrides the stale `app.settings` boot snapshot. */
  readonly settingsSnapshot?: Settings;
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
  readonly plannedLeaves?: readonly string[];
  readonly terminalSubstepName?: string;
} => ({
  ...(result.taskNames !== undefined ? { taskNames: result.taskNames } : {}),
  ...(result.maxTurns !== undefined ? { maxTurns: result.maxTurns } : {}),
  ...(result.plannedLeaves !== undefined ? { plannedLeaves: result.plannedLeaves } : {}),
  ...(result.terminalSubstepName !== undefined ? { terminalSubstepName: result.terminalSubstepName } : {}),
});

/**
 * Models the user can choose from for the configured provider — passed to the model picker
 * in the flow menu. Lookup is keyed by `settings.ai.provider`, so switching the provider in
 * Settings instantly changes the picker's option list.
 */
export const modelsForConfiguredProvider = (settings: AppDeps['settings']): readonly string[] => {
  switch (settings.ai.provider) {
    case 'claude-code':
      return CLAUDE_MODELS;
    case 'github-copilot':
      return COPILOT_MODELS;
    case 'openai-codex':
      return CODEX_MODELS;
  }
};

/**
 * Default AI model for one flow, derived from settings — exposed for UI affordances that want
 * to show "you're about to launch with model X" before actually calling {@link launchFlow}.
 * Returns `undefined` for flows that don't run an AI session (doctor, settings, create-pr,
 * export, ticket-add / remove, add-tickets, create-sprint).
 */
export const modelForFlow = (flowId: string, settings: AppDeps['settings']): string | undefined => {
  switch (flowId) {
    case 'refine':
      return settings.ai.models.refine;
    case 'plan':
      return settings.ai.models.plan;
    case 'implement':
      return settings.ai.models.implement;
    case 'readiness':
    case 'detect-scripts':
    case 'detect-skills':
      // Same read-only inventory tier — see launcher cases.
      return settings.ai.models.readiness;
    case 'ideate':
      return settings.ai.models.ideate;
    default:
      return undefined;
  }
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
  // adapter-rebuild block below depends on `settings.ai.provider` matching the user's current
  // choice. Callers that already reloaded (e.g. flows-view, for its model picker) just pass
  // their fresh snapshot via `extras.settingsSnapshot`; callers that didn't (project-detail-
  // view) implicitly opt into a one-roundtrip reload here so they don't have to remember.
  let settings = extras.settingsSnapshot ?? deps.app.settings;
  if (extras.settingsSnapshot === undefined) {
    const reloaded = await deps.app.settingsRepo.load();
    if (reloaded.ok) settings = reloaded.value;
  }

  // Rebuild the provider-bound adapters from the fresh settings every launch. `app.provider`,
  // `app.interactiveAi`, and `app.skillsAdapter` are wired once at `wire()` time from the
  // boot-time `settings.ai.provider`; switching the provider in the Settings view mutates the
  // on-disk settings file but does NOT replace those frozen closures. Without this rebuild, a
  // user who boots with Claude, switches to Copilot in Settings, and then launches Refine would
  // still get the Claude adapter spawned. These factories are tiny (no I/O, no async) so a
  // per-launch rebuild is essentially free; the alternative — a long-lived settings
  // subscription — would force every adapter consumer through a level of indirection nobody
  // else needs.
  const provider = createAiProvider({
    ai: settings.ai,
    harnessConfig: settings.harness,
    eventBus: deps.app.eventBus,
  });
  const interactiveAi = createInteractiveAiProvider({ ai: settings.ai, eventBus: deps.app.eventBus });
  const skillsAdapter = createSkillsAdapter({ provider: settings.ai.provider, logger: deps.app.logger });

  // Compose the static bundled skill source with a project-scoped source that emits per-repo
  // setup / verify skills authored via the detect-skills flow. The project-source closure reads
  // through `snapshot.project` so every install-skills leaf during this chain run sees the latest
  // skills as of launch time. Flows that run without a project (none today) fall back cleanly
  // to bundled-only.
  const projectSource = createProjectSkillSource({ getProject: () => snapshot.project });
  const composedSkillSource = composeSkillSources(deps.app.skillSource, projectSource);

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
  };

  switch (flowId) {
    case 'create-sprint':
      return launchCreateSprint(ctx);
    case 'add-tickets':
      return launchAddTickets(ctx);
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
};
