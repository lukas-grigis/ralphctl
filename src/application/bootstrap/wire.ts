import type { HeadlessAiProvider } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { InteractiveAiProvider } from '@src/integration/ai/providers/_engine/interactive-ai-provider.ts';
import type { IssueFetcher } from '@src/business/scm/issue-fetcher.ts';
import type { IssuePusher } from '@src/business/scm/issue-pusher.ts';
import type { ProjectRepository } from '@src/domain/repository/project/project-repository.ts';
import type { SprintExecutionRepository } from '@src/domain/repository/sprint/sprint-execution-repository.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { TaskRepository } from '@src/domain/repository/task/task-repository.ts';
import { createGitRunner, type GitRunner } from '@src/integration/io/git-runner.ts';
import { createShellScriptRunner, type ShellScriptRunner } from '@src/integration/io/shell-script-runner.ts';
import { createFsProjectRepository } from '@src/integration/persistence/project/repository.ts';
import { createFsSprintExecutionRepository } from '@src/integration/persistence/sprint-execution/repository.ts';
import { createFsSprintRepository } from '@src/integration/persistence/sprint/repository.ts';
import { createFsTaskRepository } from '@src/integration/persistence/task/repository.ts';
import { createFileLocker, type FileLocker } from '@src/integration/io/file-locker.ts';
import { createAtomicWriteFile } from '@src/integration/io/write-file-atomic.ts';
import type { WriteFile } from '@src/business/io/write-file.ts';
import { createAppendFile } from '@src/integration/io/append-file-adapter.ts';
import type { AppendFile } from '@src/business/io/append-file.ts';
import type { Spawn } from '@src/integration/io/spawn.ts';
import { crossPlatformSpawn } from '@src/integration/io/cross-platform-spawn.ts';
import type { ProviderSpawn } from '@src/integration/ai/providers/_engine/spawn.ts';
import { createAiProvider } from '@src/application/bootstrap/provider-factory.ts';
import {
  createInteractiveAiProvider,
  createInteractiveAiProviderFor,
} from '@src/application/bootstrap/interactive-provider-factory.ts';
import type { AiProvider, Settings } from '@src/domain/entity/settings.ts';
import { createIssueFetcher } from '@src/integration/scm/issue-fetcher.ts';
import { createIssuePusher } from '@src/integration/scm/issue-pusher.ts';
import type { PullRequestCreator } from '@src/business/scm/pull-request-creator.ts';
import { createPullRequestCreator } from '@src/integration/scm/pull-request-creator.ts';
import type { StoragePaths } from '@src/application/bootstrap/storage-paths.ts';
import type { SettingsRepository } from '@src/domain/repository/settings/settings-repository.ts';
import { createJsonSettingsRepository } from '@src/integration/persistence/settings/json-settings-repository.ts';
import type { TemplateLoader } from '@src/integration/ai/prompts/_engine/template-loader.ts';
import { createFsTemplateLoader, defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { ReadinessProbeRegistry } from '@src/integration/ai/readiness/_engine/probe.ts';
import { claudeProbe } from '@src/integration/ai/readiness/claude/probe.ts';
import { codexProbe } from '@src/integration/ai/readiness/codex/probe.ts';
import { opencodeProbe } from '@src/integration/ai/readiness/opencode/probe.ts';
import { copilotProbe } from '@src/integration/ai/readiness/copilot/probe.ts';
import { grokProbe } from '@src/integration/ai/readiness/grok/probe.ts';
import type { ModelAvailabilityProbeRegistry } from '@src/integration/ai/providers/_engine/model-availability-probe.ts';
import { claudeModelAvailabilityProbe } from '@src/integration/ai/providers/claude/model-availability-probe.ts';
import { codexModelAvailabilityProbe } from '@src/integration/ai/providers/codex/model-availability-probe.ts';
import { createOpencodeModelAvailabilityProbe } from '@src/integration/ai/providers/opencode/model-availability-probe.ts';
import { copilotModelAvailabilityProbe } from '@src/integration/ai/providers/copilot/model-availability-probe.ts';
import { grokModelAvailabilityProbe } from '@src/integration/ai/providers/grok/model-availability-probe.ts';
import { PROVIDER_TRAITS } from '@src/integration/ai/providers/_engine/provider-traits.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import { createEventBusLogger } from '@src/business/observability/event-bus-logger.ts';
import type { VersionChecker } from '@src/business/version/version-checker.ts';
import { createNpmVersionChecker } from '@src/integration/version/npm-version-checker.ts';
import { CLI_METADATA } from '@src/business/version/cli-metadata.ts';
import { warnEscalationMapSelfLoops } from '@src/business/task/escalation-map.ts';
import type { SkillsAdapter } from '@src/integration/ai/skills/_engine/skills-port.ts';
import type { SkillSource } from '@src/integration/ai/skills/_engine/skill-source.ts';
import { createSkillsAdapter } from '@src/integration/ai/skills/adapter-factory.ts';
import { createBundledSkillRawReader, createBundledSkillSource } from '@src/integration/ai/skills/bundled/source.ts';
import type { SkillCatalogPort } from '@src/integration/ai/skills/_engine/skill-catalog-port.ts';
import { createSkillCatalog } from '@src/integration/ai/skills/phase/catalog.ts';
import type { AgentDefinitionAdapter } from '@src/integration/ai/agents/_engine/agent-definition-adapter.ts';
import type { AgentDefinitionSource } from '@src/integration/ai/agents/_engine/agent-definition-source.ts';
import { createAgentDefinitionAdapter } from '@src/integration/ai/agents/adapter-factory.ts';
import { composeAgentDefinitionSources } from '@src/integration/ai/agents/_engine/compose-agent-definition-sources.ts';
import { createBundledAgentDefinitionSource } from '@src/integration/ai/agents/bundled/source.ts';
import { createOperatorAgentDefinitionSource } from '@src/integration/ai/agents/operator/source.ts';
import { warnIfVague } from '@src/integration/ai/agents/_engine/agent-definition-quality.ts';
import type { NotificationDispatcher } from '@src/business/observability/notification-dispatcher.ts';
import { startFileLogSink } from '@src/integration/observability/sinks/file-log-sink.ts';
import type { FileLogSink, FileLogSinkDeps } from '@src/integration/observability/_engine/file-log-sink.ts';

/**
 * Slim, launch-time-supplied subset of {@link FileLogSinkDeps} — `appendFile` is bound at
 * `wire()` time and threaded into the production sink internally so callers don't have to
 * re-thread it on every launch.
 */
export type ChainLogSinkLaunchDeps = Omit<FileLogSinkDeps, 'appendFile'>;

/**
 * Wired application dependencies. Composition root assembles these once at startup; everything
 * downstream (chains, CLI, TUI) consumes from this bag.
 *
 * Per-flow dep types (`RefineDeps`, `PlanDeps`, …) narrow this further at the chain factory
 * boundary so each flow's signature documents exactly what it depends on. `AppDeps` is the
 * superset the composition root produces — it's the type the typechecker uses to prove
 * "every port the app needs is actually wired" at the bootstrap boundary.
 *
 * `settings` is threaded through here as a boot-time snapshot so chain factories can read
 * their own slice (the implement chain reads `settings.harness.maxTurns`, future flows will
 * read other slices). Use-cases that *mutate* settings (e.g. `settings-set`) consume
 * `settingsRepo` directly so writes round-trip through validation.
 */
export interface AppDeps {
  /**
   * Resolved storage paths — exposed so flows / TUI views can derive per-sprint paths
   * (`<dataRoot>/sprints/<sprintId>/`) without re-resolving from env or `os.homedir()`.
   * The composition root computes this once; callers down the tree consume the same record.
   */
  readonly storage: StoragePaths;
  readonly projectRepo: ProjectRepository;
  readonly sprintRepo: SprintRepository;
  readonly sprintExecutionRepo: SprintExecutionRepository;
  readonly taskRepo: TaskRepository;
  /** Validated application settings — boot-time snapshot. Sliced by chain factories that need it. */
  readonly settings: Settings;
  /**
   * Persistence port for {@link Settings}. Used by use-cases that read/write at runtime
   * (`settings-show`, `settings-set`); the boot-time snapshot above is for chain factories
   * that don't need to react to mid-session mutations.
   */
  readonly settingsRepo: SettingsRepository;
  /**
   * Provider built via {@link createAiProvider} from `settings.ai`. Chain factories pluck this
   * field off `AppDeps` directly — every flow's `Deps` already declares `provider: HeadlessAiProvider`.
   */
  readonly provider: HeadlessAiProvider;
  /**
   * The spawn seam the AI adapters were built with, re-exposed so it SURVIVES the per-launch
   * adapter rebuild. `buildLaunchAdapters` (and the implement launcher's per-role rebuild)
   * reconstruct providers from the freshly-resolved settings on every launch; without this field
   * a wire-time `spawn` override reached `AppDeps.provider` and was then silently dropped the
   * moment a flow actually launched — which made the override useless for anything that goes
   * through a launcher.
   *
   * Two producers today: a test that wants a hermetic launch, and `ralphctl demo --script`,
   * whose scripted spawn replays a canned transcript instead of running a CLI. Presence of this
   * field is therefore also the "no real binary will be spawned" signal the implement launcher
   * reads to skip its PATH pre-flight.
   *
   * Undefined in ordinary production runs — the adapters fall back to `node:child_process.spawn`.
   */
  readonly providerSpawn?: ProviderSpawn;
  /** External shells — used by implement (preflight + commit) and review (commit). */
  readonly gitRunner: GitRunner;
  /** Project-configured shell scripts — used by implement (setup + post-task verify) and review (verify). */
  readonly shellScriptRunner: ShellScriptRunner;
  /** Advisory cooperative file lock — used to serialise per-repository runs. */
  readonly fileLocker: FileLocker;
  /**
   * Atomic file writer — used by interactive flows (refine, plan-interactive) to materialise
   * `prompt.md` before handing the terminal to Claude.
   */
  readonly writeFile: WriteFile;
  /**
   * Append-only writer — used by the progress-journal leaves to grow
   * `<sprintDir>/progress.md` per task-attempt settlement and status transition (audit-[07]),
   * and by the opt-in `<sprintDir>/events.ndjson` debug-trace sink. Also threaded into the
   * review chain so feedback-round appends round through the port instead of `fs.appendFile`.
   */
  readonly appendFile: AppendFile;
  /**
   * Interactive AI session — used by refine and plan-interactive. Sibling of `provider`
   * (which is the headless variant). Each adapter handles its own mode; flows pick the one
   * matching their UX.
   */
  readonly interactiveAi: InteractiveAiProvider;
  /**
   * Per-provider interactive-AI factory — selects the concrete {@link InteractiveAiProvider} for
   * an explicit {@link AiProvider} (vs. the flow-keyed `interactiveAi` seed above). Threaded so
   * the distill sub-chain's per-distinct-provider fan-out can spawn one interactive session
   * per provider it writes a native context file for. Bound to the wire-time `eventBus` so every
   * distill session logs onto the same observability pipe.
   */
  readonly interactiveAiFor: (provider: AiProvider) => InteractiveAiProvider;
  /**
   * Filesystem-backed prompt template loader — every AI-touching flow needs one. Built once
   * here so flows don't each call `createFsTemplateLoader(defaultTemplatesDir())`.
   */
  readonly templateLoader: TemplateLoader;
  /** Wall-clock for entity timestamps. Bound to {@link IsoTimestamp.now}; tests pass a fake. */
  readonly clock: () => IsoTimestamp;
  /**
   * Readiness probe registry — keyed by tool. Used by `readiness` to dispatch
   * filesystem probes (`AGENTS.md`, `.github/copilot-instructions.md`, …).
   */
  readonly probes: ReadinessProbeRegistry;
  /**
   * Per-provider model-availability lookup. Resolves the static model catalog narrowed to the
   * models the operator's account can actually run (Codex reads `~/.codex/models_cache.json`;
   * Claude / Copilot are passthrough today). Fail-open: every error path resolves to the full
   * catalog, so the picker never blocks or hides everything.
   *
   * Result is cached per `wire()` session — it won't live-track models installed mid-session; the
   * user re-enters the surface to refresh. The probe registry itself is a `wire()` internal.
   *
   * `wire()` always assigns this; it is not optional. Test stubs that build an `AppDeps` by hand
   * (`{} as unknown as AppDeps`) suppress the missing-field error via the `unknown` cast, so
   * dropping the `?` here does not force every stub to populate it.
   */
  readonly availableModelsFor: (provider: AiProvider) => Promise<readonly string[]>;
  /**
   * Application-wide event bus. Producers (chain runner, use cases, adapters)
   * publish {@link AppEvent}s; UI surfaces and observability adapters subscribe.
   * One instance per `wire()` call — bus state isolates between concurrent app
   * instances (production vs. tests).
   */
  readonly eventBus: EventBus;
  /**
   * Logger port that emits structured `AppEvent.log` records onto {@link AppDeps.eventBus}.
   * Use cases call `props.logger.debug/info/warn/error(...)` (or `.named('feature.action')`
   * for a scoped child) and the bridge publishes log events that share the same fan-out as
   * every other observability subscriber.
   */
  readonly logger: Logger;
  /**
   * Pull-request creator (`gh` / `glab`) — used by the create-pr flow.
   * Hard-fails if the CLI is not installed; PRs have no useful fallback.
   */
  readonly pullRequestCreator: PullRequestCreator;
  /**
   * External issue fetcher (`gh` / `glab`) — used by refine when a ticket has a `link`.
   * Optional because environments without the CLIs degrade to a soft-fail no-op.
   */
  readonly issueFetcher?: IssueFetcher;
  /**
   * External issue pusher (`gh` / `glab`) — used by the refine flow's "Approve & update
   * origin" path. Same lifetime / availability story as `issueFetcher`: optional, and a
   * push failure never blocks local refinement (REQ-10 from the requirements doc).
   */
  readonly issuePusher?: IssuePusher;
  /**
   * npm registry-backed version checker — surfaces a dim banner on Welcome / Home when a
   * newer ralphctl is published. Best-effort: every failure mode (offline, parse error,
   * timeout) returns `null` so the UI never sees an error from this path.
   */
  readonly versionChecker: VersionChecker;
  /**
   * Provider-specific skills installer — writes the resolved {@link Skill}s into the
   * location the selected AI CLI auto-discovers (`<sandboxCwd>/.claude/skills/<id>/SKILL.md`
   * for Claude; no-op for Copilot / Codex today).
   */
  readonly skillsAdapter: SkillsAdapter;
  /**
   * Source of canonical {@link Skill}s for a flow. `wire()` binds the static BUNDLED source
   * only; the launcher composes it per launch with the project-scoped source (setup / verify
   * skills authored via detect-skills) and the operator drop-in source — see
   * `composeSkillSources` in `ui/shared/launcher.ts`.
   */
  readonly skillSource: SkillSource;
  /**
   * TUI skill-catalog port — backs the browsable Skills view (enable / disable / update /
   * update-all the opt-in phase-scoped skills). Built once per `wire()` call over the same
   * `operatorSkillsRoot` and `writeFile` seam as the rest of the skills stack.
   */
  readonly skillCatalog: SkillCatalogPort;
  /**
   * Wire-time seed — keyed on the generator role's provider. The implement launcher rebuilds a
   * role-scoped adapter per role (generator / evaluator may target different providers) via
   * `createAgentDefinitionAdapter`; this field is the sensible default for any path that consults
   * `app.agentDefinitionAdapter` before a launch. Mirrors {@link skillsAdapter}'s wire-time-seed
   * posture.
   */
  readonly agentDefinitionAdapter: AgentDefinitionAdapter;
  /**
   * Composed bundled + operator agent-definition source (operator overrides bundled on a name
   * collision — see `composeAgentDefinitionSources`'s doc comment). Unlike {@link skillSource},
   * agent definitions have no per-project / phase tier: a project-authored definition already
   * lives where the provider's CLI looks for it, so there is nothing further to compose here.
   */
  readonly agentDefinitionSource: AgentDefinitionSource;
  /**
   * OS-attention notifier. Hooked onto the EventBus by {@link startNotificationSubscriber} at
   * `wire()` time; exposed on `AppDeps` so flows / tests that want to surface a one-shot
   * "ralphctl needs you" cue can call it directly. Production: terminal bell + Darwin
   * NotificationCenter / Linux libnotify. Tests: a no-op stub unless one is injected.
   */
  readonly notificationDispatcher: NotificationDispatcher;
  /**
   * Per-launch factory for the opt-in `<sprintDir>/events.ndjson` tee subscriber. Returns
   * an opaque `{ stop, flush }` handle the launcher attaches and tears down at terminal
   * events.
   *
   * Gated by `RALPHCTL_DEBUG_TRACE`: when the env var is set to a truthy value `wire()`
   * binds the real {@link startFileLogSink}; otherwise a no-op factory returns idempotent
   * stubs so callers don't need to branch. Keeping the env read here means integration
   * adapters never reach for `process.env` directly — the bootstrap layer owns the
   * "is debug tracing on?" question.
   */
  readonly chainLogSink: (deps: ChainLogSinkLaunchDeps) => FileLogSink;
}

/**
 * Injection points for `wire()`. Production paths come from `resolveStoragePaths()`; tests
 * build their own from a tmp directory via `storagePathsFromRoot(tmpDir)` so no test ever
 * touches the real `~/.ralphctl/` tree.
 *
 * Future injection points (AI session, clock, logger) land here as they're introduced — the
 * test seam stays the same shape.
 */
export interface WireOptions {
  readonly storage: StoragePaths;
  readonly settings: Settings;
  /**
   * Test seam threaded through {@link createAiProvider} into the Claude adapter. Production
   * leaves this `undefined` so the adapter spawns the real `claude` CLI; the wire integration
   * test passes a fake spawn so the test exercises the full wiring without a real binary.
   */
  readonly spawn?: ProviderSpawn;
  /**
   * AI-only spawn override. Distinct from {@link spawn}, which doubles as the general-purpose
   * `Spawn` for git / gh / the issue fetcher: a caller that fakes the AI CLI usually still wants
   * REAL git (this is exactly `ralphctl demo --script`'s situation — a canned session, a real
   * repository, a real commit).
   *
   * Takes precedence over `spawn` for provider construction, and is what `AppDeps.providerSpawn`
   * carries to launch time.
   */
  readonly providerSpawn?: ProviderSpawn;
  /**
   * Optional override for the OS attention notifier. Production callers (the TUI bootstrap in
   * `launch.ts`) pass the real Darwin / Linux adapter; the default for unspecified callers is a
   * silent no-op so tests don't accidentally pop NotificationCenter dings on the dev machine
   * when they exercise a chain that fires an attention event.
   */
  readonly notificationDispatcher?: NotificationDispatcher;
  /**
   * Test seam for `process.env` lookups (currently `RALPHCTL_DEBUG_TRACE`). Defaults to the
   * live `process.env`. Tests pass a frozen record so they can flip the debug trace flag
   * without touching the ambient process state.
   */
  readonly env?: NodeJS.ProcessEnv;
}

/** Env var that enables persistent `<sprintDir>/events.ndjson` file-log sink writes. */
export const RALPHCTL_DEBUG_TRACE_ENV = 'RALPHCTL_DEBUG_TRACE';

/**
 * No-op chain-log sink — returned by the factory when `RALPHCTL_DEBUG_TRACE` is unset. The
 * launcher's `subscribe()` callback still calls `stop()` + `flush()` at terminal events,
 * so the shape has to match {@link FileLogSink} exactly even when nothing is being written.
 */
const NOOP_CHAIN_LOG_SINK: FileLogSink = {
  stop(): void {
    // intentionally no-op
  },
  async flush(): Promise<void> {
    // intentionally no-op
  },
};

const isTruthyEnvFlag = (value: string | undefined): boolean => typeof value === 'string' && value.length > 0;

/**
 * Build the wired dependency graph. Pure — does not touch the filesystem or `os`. Production
 * `main()` composes:
 *
 *     resolveStoragePaths() → ensureStorageRoots(paths) →
 *     createJsonSettingsRepository({ configRoot }).load() →
 *     wire({ storage: paths, settings })
 *
 * Tests skip the resolver and call `wire({ storage: storagePathsFromRoot(tmpDir).value,
 * settings: DEFAULT_SETTINGS })` directly. Same shape, different paths — the application code
 * under test is identical to production.
 */
/**
 * Default `Spawn` for general shell use (issue fetcher, interactive Claude binary). Falls
 * through to `node:child_process.spawn`. Tests can pass an alternative via `WireOptions.spawn`
 * — the same fake currently scripted for the headless provider.
 */
const defaultPipeSpawn: Spawn = (command, args, options) =>
  crossPlatformSpawn(command, args, {
    ...options,
    stdio: [...options.stdio],
  }) as ReturnType<Spawn>;

/**
 * Built once per `wire()` call. Probes are static module-level singletons; bundling them here
 * means every flow reads `app.probes` instead of carrying its own registry literal.
 */
const PROBES: ReadinessProbeRegistry = {
  'claude-code': claudeProbe,
  copilot: copilotProbe,
  codex: codexProbe,
  opencode: opencodeProbe,
  grok: grokProbe,
};

/**
 * Model-availability probe registry, keyed by {@link AiProvider}, so `wire()` can dispatch
 * per-provider without each caller carrying a registry literal. Keyed on the provider union (vs.
 * {@link PROBES}, which is keyed on `AssistantTool`).
 *
 * Built per `wire()` call rather than as a module singleton because the opencode probe takes an
 * observability seam: it is the one backend whose fallback catalog is NOT the vendor's full list
 * (only the zero-auth free tier), so a fail-open there silently shrinks the picker and has to
 * leave a trace. The other four are stateless singletons.
 */
const buildModelAvailabilityProbes = (logger: Logger): ModelAvailabilityProbeRegistry => ({
  'claude-code': claudeModelAvailabilityProbe,
  'github-copilot': copilotModelAvailabilityProbe,
  'openai-codex': codexModelAvailabilityProbe,
  opencode: createOpencodeModelAvailabilityProbe({
    onDegraded: ({ reason, detail }) => {
      logger.warn('model-probe: opencode fell back to the shipped free-tier catalog', { reason, detail });
    },
  }),
  'xai-grok': grokModelAvailabilityProbe,
});

/** Silent default dispatcher — used when no production override is passed (i.e. by tests). */
const noopNotificationDispatcher: NotificationDispatcher = {
  async notify() {
    // intentionally no-op
  },
};

/** Wire-time seed adapter, keyed on the generator role's provider — see `AppDeps.agentDefinitionAdapter`. */
const buildWireAgentDefinitionAdapter = (settings: Settings, logger: Logger): AgentDefinitionAdapter =>
  createAgentDefinitionAdapter({ provider: settings.ai.implement.generator.provider, logger });

/** Composed bundled + operator agent-definition source — see `AppDeps.agentDefinitionSource`. */
const buildWireAgentDefinitionSource = (storage: StoragePaths, logger: Logger): AgentDefinitionSource =>
  composeAgentDefinitionSources(
    createBundledAgentDefinitionSource(),
    createOperatorAgentDefinitionSource({
      operatorAgentDefinitionsRoot: storage.operatorAgentDefinitionsRoot,
      logger,
      warnIfVague: (definition) => warnIfVague(logger, definition),
    })
  );

/**
 * Wire-time seed provider. The per-launch launcher rebuilds the provider per dispatched flow;
 * the `implement` row is the most common consumer, so it is the sensible default for any path
 * that reads `app.provider` before a launch happens.
 */
const buildWireProvider = (opts: WireOptions, eventBus: EventBus, spawn: ProviderSpawn | undefined) =>
  createAiProvider({
    flow: 'implement',
    ai: opts.settings.ai,
    harnessConfig: opts.settings.harness,
    eventBus,
    ...(spawn !== undefined ? { spawn } : {}),
  });

export const wire = (opts: WireOptions): AppDeps => {
  const spawn: Spawn = opts.spawn ?? defaultPipeSpawn;
  // AI adapters prefer the dedicated override, then fall back to the general seam so existing
  // callers that pass only `spawn` keep faking the provider exactly as before.
  const providerSpawn: ProviderSpawn | undefined = opts.providerSpawn ?? opts.spawn;
  // Env-gated chain.log writes. Reading `process.env` here keeps the integration adapter
  // (`startFileLogSink`) pure — it never needs to know whether tracing is enabled, only
  // whether to wire up. The no-op factory matches the live shape so callers can call
  // `stop()` / `flush()` unconditionally at terminal events.
  const env = opts.env ?? process.env;
  const debugTrace = isTruthyEnvFlag(env[RALPHCTL_DEBUG_TRACE_ENV]);
  const appendFile = createAppendFile();
  // Bind `appendFile` at wire-time so the launcher factory keeps the same `{ file, bus }`
  // call shape regardless of whether the real sink or the no-op stub is in play.
  const chainLogSink: (deps: ChainLogSinkLaunchDeps) => FileLogSink = debugTrace
    ? (launchDeps) => startFileLogSink({ ...launchDeps, appendFile })
    : () => NOOP_CHAIN_LOG_SINK;
  // One bus per `wire()` call — bus state isolates between concurrent app
  // instances. Adapters publish 'log' AppEvents directly; the bus is the
  // unified pipe TUI panels, file appenders, and webhooks all subscribe to.
  const eventBus = createInMemoryEventBus();
  const logger = createEventBusLogger({ eventBus, clock: IsoTimestamp.now });
  // Settings-load-time validation that emits, but does not reject: self-loop escalation-map
  // entries (`'foo' → 'foo'`) parse cleanly through the schema but have no runtime effect, so
  // we surface them as warn-level log records the user can spot in the TUI status panel.
  warnEscalationMapSelfLoops(opts.settings.harness.escalationMap, logger);
  // OS-attention notifier slot. The TUI bootstrap (launch.ts) injects the real Darwin/Linux
  // adapter and ALSO calls `startNotificationSubscriber` to attach it to the bus; everything
  // else (tests, CLI one-shots) takes the no-op fallback and no subscriber is started, so an
  // accidental NotificationCenter ding from a unit test is impossible.
  const notificationDispatcher = opts.notificationDispatcher ?? noopNotificationDispatcher;
  // Hoisted so taskRepo can share the same locker for its per-file read-modify-write guard.
  // One locker instance per app means stale-takeover semantics agree across every caller.
  const fileLocker = createFileLocker({
    // Surface stale `.lock` files via the application logger. The locker is intentionally
    // logger-free at the integration layer; this bootstrap hookup keeps the observability
    // wiring in one place.
    onWarning: ({ kind, path, cause }) => {
      logger.warn(`file-locker: ${kind}`, {
        path,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    },
  });
  // Memoised per-provider model-availability lookup. Cache lives for the AppDeps lifetime and keys
  // on the in-flight Promise (not the resolved value) so concurrent callers for the same provider
  // share one probe execution — "runs at most once per provider per session". The probe never
  // rejects (fail open), so there's no error path to evict on. Won't live-track mid-session installs.
  const availableModelsInFlight = new Map<AiProvider, Promise<readonly string[]>>();
  const modelAvailabilityProbes = buildModelAvailabilityProbes(logger);
  const availableModelsFor = (provider: AiProvider): Promise<readonly string[]> => {
    const existing = availableModelsInFlight.get(provider);
    if (existing !== undefined) return existing;
    const pending = modelAvailabilityProbes[provider].availableModels(PROVIDER_TRAITS[provider].modelCatalog);
    availableModelsInFlight.set(provider, pending);
    return pending;
  };
  // Hoisted so the skill catalog's provenance-stamp writes share the exact same atomic-write
  // seam as `AppDeps.writeFile` (one factory call, two consumers).
  const atomicWriteFile = createAtomicWriteFile();
  return {
    storage: opts.storage,
    projectRepo: createFsProjectRepository({ root: opts.storage.dataRoot }),
    sprintRepo: createFsSprintRepository({ root: opts.storage.dataRoot }),
    sprintExecutionRepo: createFsSprintExecutionRepository({ root: opts.storage.dataRoot }),
    taskRepo: createFsTaskRepository({ root: opts.storage.dataRoot, fileLocker }),
    settings: opts.settings,
    settingsRepo: createJsonSettingsRepository({ configRoot: opts.storage.configRoot }),
    provider: buildWireProvider(opts, eventBus, providerSpawn),
    ...(providerSpawn !== undefined ? { providerSpawn } : {}),
    gitRunner: createGitRunner(),
    shellScriptRunner: createShellScriptRunner(),
    fileLocker,
    writeFile: atomicWriteFile,
    appendFile,
    interactiveAi: createInteractiveAiProvider({ flow: 'refine', ai: opts.settings.ai, eventBus }),
    interactiveAiFor: (provider) => createInteractiveAiProviderFor(provider, eventBus),
    templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
    clock: IsoTimestamp.now,
    probes: PROBES,
    availableModelsFor,
    eventBus,
    logger,
    pullRequestCreator: createPullRequestCreator({ gitRunner: createGitRunner(), spawn }),
    issueFetcher: createIssueFetcher({ spawn, logger }),
    issuePusher: createIssuePusher({ spawn }),
    versionChecker: createNpmVersionChecker({
      stateRoot: opts.storage.stateRoot,
      currentVersion: CLI_METADATA.currentVersion,
      packageName: CLI_METADATA.packageName,
    }),
    // Wire-time seed — the per-launch launcher rebuilds skillsAdapter from the dispatched
    // flow's provider. Tests / one-shot CLI paths that read `app.skillsAdapter` before any
    // flow launches get the implement row's provider as the default.
    skillsAdapter: createSkillsAdapter({ provider: opts.settings.ai.implement.generator.provider, logger }),
    skillSource: createBundledSkillSource(),
    agentDefinitionAdapter: buildWireAgentDefinitionAdapter(opts.settings, logger),
    agentDefinitionSource: buildWireAgentDefinitionSource(opts.storage, logger),
    skillCatalog: createSkillCatalog({
      operatorSkillsRoot: opts.storage.operatorSkillsRoot,
      writeFile: atomicWriteFile,
      bundledRawReader: createBundledSkillRawReader(),
      logger,
    }),
    notificationDispatcher,
    chainLogSink,
  };
};
