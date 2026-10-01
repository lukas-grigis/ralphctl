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
import { warnEscalationMapRetiredValues, warnEscalationMapSelfLoops } from '@src/business/task/escalation-map.ts';
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
import { createFsHousekeepingDisk } from '@src/integration/persistence/housekeeping/fs-housekeeping-disk.ts';
import { createHousekeeping, type Housekeeping } from '@src/application/flows/housekeeping/housekeeping.ts';
import { createProjectRemoval, type ProjectRemoval } from '@src/application/flows/delete-project/project-removal.ts';
import type { FileLogSink, FileLogSinkDeps } from '@src/integration/observability/_engine/file-log-sink.ts';

/**
 * Slim, launch-time-supplied subset of {@link FileLogSinkDeps} — `appendFile` is bound at `wire()` time and threaded
 * into the production sink internally so callers don't have to re-thread it on every launch.
 */
export type ChainLogSinkLaunchDeps = Omit<FileLogSinkDeps, 'appendFile'>;

/**
 * Wired application dependencies. Composition root assembles these once at startup; everything downstream (chains,
 * CLI, TUI) consumes from this bag.
 */
export interface AppDeps {
  /**
   * Resolved storage paths — exposed so flows / TUI views can derive per-sprint paths
   * (`<dataRoot>/sprints/<sprintId>/`) without re-resolving from env or `os.homedir()`.
   */
  readonly storage: StoragePaths;
  readonly projectRepo: ProjectRepository;
  readonly sprintRepo: SprintRepository;
  readonly sprintExecutionRepo: SprintExecutionRepository;
  readonly taskRepo: TaskRepository;
  /** Validated application settings — boot-time snapshot. Sliced by chain factories that need it. */
  readonly settings: Settings;
  /** Persistence port for {@link Settings}. */
  readonly settingsRepo: SettingsRepository;
  /** Provider built via {@link createAiProvider} from `settings.ai`. */
  readonly provider: HeadlessAiProvider;
  /**
   * The spawn seam the AI adapters were built with, re-exposed so it SURVIVES the per-launch adapter rebuild.
   */
  readonly providerSpawn?: ProviderSpawn;
  /** External shells — used by implement (preflight + commit) and review (commit). */
  readonly gitRunner: GitRunner;
  /** Project-configured shell scripts — used by implement (setup + post-task verify) and review (verify). */
  readonly shellScriptRunner: ShellScriptRunner;
  /** Advisory cooperative file lock — used to serialise per-repository runs. */
  readonly fileLocker: FileLocker;
  /**
   * Atomic file writer — used by interactive flows (refine, plan-interactive) to materialise `prompt.md` before
   * handing the terminal to Claude.
   */
  readonly writeFile: WriteFile;
  /**
   * Append-only writer — used by the progress-journal leaves to grow `<sprintDir>/progress.md` per task-attempt
   * settlement and status transition (audit-[07]).
   */
  readonly appendFile: AppendFile;
  /**
   * Interactive AI session — used by refine and plan-interactive. Sibling of `provider` (which is the headless
   * variant).
   */
  readonly interactiveAi: InteractiveAiProvider;
  /**
   * Per-provider interactive-AI factory — selects the concrete {@link InteractiveAiProvider} for an explicit {@link
   * AiProvider} (vs. the flow-keyed `interactiveAi` seed above).
   */
  readonly interactiveAiFor: (provider: AiProvider) => InteractiveAiProvider;
  /**
   * Filesystem-backed prompt template loader — every AI-touching flow needs one. Built once here so flows don't each
   * call `createFsTemplateLoader(defaultTemplatesDir())`.
   */
  readonly templateLoader: TemplateLoader;
  /** Wall-clock for entity timestamps. Bound to {@link IsoTimestamp.now}; tests pass a fake. */
  readonly clock: () => IsoTimestamp;
  /**
   * Readiness probe registry — keyed by tool. Used by `readiness` to dispatch filesystem probes (`AGENTS.md`,
   * `.github/copilot-instructions.md`, …).
   */
  readonly probes: ReadinessProbeRegistry;
  /** Per-provider model-availability lookup. */
  readonly availableModelsFor: (provider: AiProvider) => Promise<readonly string[]>;
  /**
   * Application-wide event bus. Producers (chain runner, use cases, adapters) publish {@link AppEvent}s; UI surfaces
   * and observability adapters subscribe.
   */
  readonly eventBus: EventBus;
  /** Logger port that emits structured `AppEvent.log` records onto {@link AppDeps.eventBus}. */
  readonly logger: Logger;
  /**
   * Pull-request creator (`gh` / `glab`) — used by the create-pr flow. Hard-fails if the CLI is not installed; PRs
   * have no useful fallback.
   */
  readonly pullRequestCreator: PullRequestCreator;
  /**
   * External issue fetcher (`gh` / `glab`) — used by refine when a ticket has a `link`. Optional because environments
   * without the CLIs degrade to a soft-fail no-op.
   */
  readonly issueFetcher?: IssueFetcher;
  /** External issue pusher (`gh` / `glab`) — used by the refine flow's "Approve & update origin" path. */
  readonly issuePusher?: IssuePusher;
  /**
   * npm registry-backed version checker — surfaces a dim banner on Welcome / Home when a newer ralphctl is published.
   */
  readonly versionChecker: VersionChecker;
  /**
   * Provider-specific skills installer — writes the resolved {@link Skill}s into the location the selected AI CLI
   * auto-discovers (`<sandboxCwd>/.claude/skills/<id>/SKILL.md` for Claude; no-op for Copilot / Codex today).
   */
  readonly skillsAdapter: SkillsAdapter;
  /** Source of canonical {@link Skill}s for a flow. */
  readonly skillSource: SkillSource;
  /**
   * TUI skill-catalog port — backs the browsable Skills view (enable / disable / update / update-all the opt-in
   * phase-scoped skills).
   */
  readonly skillCatalog: SkillCatalogPort;
  /** Wire-time seed — keyed on the generator role's provider. */
  readonly agentDefinitionAdapter: AgentDefinitionAdapter;
  /**
   * Composed bundled + operator agent-definition source (operator overrides bundled on a name collision — see
   * `composeAgentDefinitionSources`'s doc comment).
   */
  readonly agentDefinitionSource: AgentDefinitionSource;
  /** OS-attention notifier. */
  readonly notificationDispatcher: NotificationDispatcher;
  /** Per-launch factory for the opt-in `<sprintDir>/events.ndjson` tee subscriber. */
  readonly chainLogSink: (deps: ChainLogSinkLaunchDeps) => FileLogSink;
  /** Housekeeping view backend — dry-run scan of reclaimable data and a re-verifying purge. */
  readonly housekeeping: Housekeeping;
  /** Project removal with the opt-in sprints + memory cascade. */
  readonly projectRemoval: ProjectRemoval;
}

/** Injection points for `wire()`. */
export interface WireOptions {
  readonly storage: StoragePaths;
  readonly settings: Settings;
  /** Test seam threaded through {@link createAiProvider} into the Claude adapter. */
  readonly spawn?: ProviderSpawn;
  /** AI-only spawn override. */
  readonly providerSpawn?: ProviderSpawn;
  /** Optional override for the OS attention notifier. */
  readonly notificationDispatcher?: NotificationDispatcher;
  /**
   * Test seam for `process.env` lookups (currently `RALPHCTL_DEBUG_TRACE`). Defaults to the live `process.env`.
   */
  readonly env?: NodeJS.ProcessEnv;
}

/** Env var that enables persistent `<sprintDir>/events.ndjson` file-log sink writes. */
export const RALPHCTL_DEBUG_TRACE_ENV = 'RALPHCTL_DEBUG_TRACE';

/** No-op chain-log sink — returned by the factory when `RALPHCTL_DEBUG_TRACE` is unset. */
const NOOP_CHAIN_LOG_SINK: FileLogSink = {
  stop(): void {
    // intentionally no-op
  },
  async flush(): Promise<void> {
    // intentionally no-op
  },
};

const isTruthyEnvFlag = (value: string | undefined): boolean => typeof value === 'string' && value.length > 0;

/** Build the wired dependency graph. Pure — does not touch the filesystem or `os`. */
/**
 * Default `Spawn` for general shell use (issue fetcher, interactive Claude binary). Falls through to
 * `node:child_process.spawn`.
 */
const defaultPipeSpawn: Spawn = (command, args, options) =>
  crossPlatformSpawn(command, args, {
    ...options,
    stdio: [...options.stdio],
  }) as ReturnType<Spawn>;

/** Built once per `wire()` call. */
const PROBES: ReadinessProbeRegistry = {
  'claude-code': claudeProbe,
  copilot: copilotProbe,
  codex: codexProbe,
  opencode: opencodeProbe,
  grok: grokProbe,
};

/**
 * Model-availability probe registry, keyed by {@link AiProvider}, so `wire()` can dispatch per-provider without each
 * caller carrying a registry literal.
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

/** Wire-time seed provider. */
const buildWireProvider = (opts: WireOptions, eventBus: EventBus, spawn: ProviderSpawn | undefined) =>
  createAiProvider({
    flow: 'implement',
    ai: opts.settings.ai,
    harnessConfig: opts.settings.harness,
    eventBus,
    ...(spawn !== undefined ? { spawn } : {}),
  });

/** Project + sprint repositories and the services that delete across them, sharing one disk adapter. */
const buildDataServices = (
  storage: StoragePaths,
  logger: Logger
): Pick<AppDeps, 'projectRepo' | 'sprintRepo' | 'housekeeping' | 'projectRemoval'> => {
  const projectRepo = createFsProjectRepository({ root: storage.dataRoot });
  const sprintRepo = createFsSprintRepository({ root: storage.dataRoot });
  const housekeepingDisk = createFsHousekeepingDisk({
    dataRoot: storage.dataRoot,
    memoryRoot: storage.memoryRoot,
    runsRoot: storage.runsRoot,
  });
  return {
    projectRepo,
    sprintRepo,
    housekeeping: createHousekeeping({ projectRepo, sprintRepo, housekeepingDisk, clock: IsoTimestamp.now, logger }),
    projectRemoval: createProjectRemoval({ projectRepo, sprintRepo, housekeepingDisk, logger }),
  };
};

export const wire = (opts: WireOptions): AppDeps => {
  const spawn: Spawn = opts.spawn ?? defaultPipeSpawn;
  // AI adapters prefer the dedicated override, then fall back to the general seam so existing
  // callers that pass only `spawn` keep faking the provider exactly as before.
  const providerSpawn: ProviderSpawn | undefined = opts.providerSpawn ?? opts.spawn;
  // Env-gated chain.log writes.
  const env = opts.env ?? process.env;
  const debugTrace = isTruthyEnvFlag(env[RALPHCTL_DEBUG_TRACE_ENV]);
  const appendFile = createAppendFile();
  // Bind `appendFile` at wire-time so the launcher factory keeps the same `{ file, bus }`
  // call shape regardless of whether the real sink or the no-op stub is in play.
  const chainLogSink: (deps: ChainLogSinkLaunchDeps) => FileLogSink = debugTrace
    ? (launchDeps) => startFileLogSink({ ...launchDeps, appendFile })
    : () => NOOP_CHAIN_LOG_SINK;
  // One bus per `wire()` call — bus state isolates between concurrent app instances.
  const eventBus = createInMemoryEventBus();
  const logger = createEventBusLogger({ eventBus, clock: IsoTimestamp.now });
  // Settings-load-time validation that emits, but does not reject: self-loop escalation-map entries (`'foo' → 'foo'`)
  // parse cleanly through the schema but have no runtime effect.
  warnEscalationMapSelfLoops(opts.settings.harness.escalationMap, logger);
  warnEscalationMapRetiredValues(opts.settings.harness.escalationMap, logger);
  // OS-attention notifier slot.
  const notificationDispatcher = opts.notificationDispatcher ?? noopNotificationDispatcher;
  // Hoisted so taskRepo can share the same locker for its per-file read-modify-write guard.
  // One locker instance per app means stale-takeover semantics agree across every caller.
  const fileLocker = createFileLocker({
    // Surface stale `.lock` files via the application logger.
    onWarning: ({ kind, path, cause }) => {
      logger.warn(`file-locker: ${kind}`, {
        path,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    },
  });
  // Memoised per-provider model-availability lookup.
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
  // Shared with IssuePusher so origin reads (`git remote get-url origin`) go through the same
  // GitRunner instance AppDeps already exposes.
  const gitRunner = createGitRunner();
  return {
    storage: opts.storage,
    ...buildDataServices(opts.storage, logger),
    sprintExecutionRepo: createFsSprintExecutionRepository({ root: opts.storage.dataRoot }),
    taskRepo: createFsTaskRepository({ root: opts.storage.dataRoot, fileLocker }),
    settings: opts.settings,
    settingsRepo: createJsonSettingsRepository({ configRoot: opts.storage.configRoot }),
    provider: buildWireProvider(opts, eventBus, providerSpawn),
    ...(providerSpawn !== undefined ? { providerSpawn } : {}),
    gitRunner,
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
    issuePusher: createIssuePusher({ spawn, gitRunner }),
    versionChecker: createNpmVersionChecker({
      stateRoot: opts.storage.stateRoot,
      currentVersion: CLI_METADATA.currentVersion,
      packageName: CLI_METADATA.packageName,
    }),
    // Wire-time seed — the per-launch launcher rebuilds skillsAdapter from the dispatched flow's provider.
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
