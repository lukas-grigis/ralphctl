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
import { spawn as nodeSpawn } from 'node:child_process';
import type { Spawn } from '@src/integration/io/spawn.ts';
import type { ProviderSpawn } from '@src/integration/ai/providers/_engine/spawn.ts';
import { createAiProvider } from '@src/application/bootstrap/provider-factory.ts';
import { createInteractiveAiProvider } from '@src/application/bootstrap/interactive-provider-factory.ts';
import { createIssueFetcher } from '@src/integration/scm/issue-fetcher.ts';
import { createIssuePusher } from '@src/integration/scm/issue-pusher.ts';
import type { PullRequestCreator } from '@src/business/scm/pull-request-creator.ts';
import { createPullRequestCreator } from '@src/integration/scm/pull-request-creator.ts';
import type { StoragePaths } from '@src/application/bootstrap/storage-paths.ts';
import type { Settings } from '@src/domain/entity/settings.ts';
import type { SettingsRepository } from '@src/domain/repository/settings/settings-repository.ts';
import { createJsonSettingsRepository } from '@src/integration/persistence/settings/json-settings-repository.ts';
import type { AppSinks } from '@src/application/bootstrap/runtime-sinks.ts';
import type { HarnessSignalSink } from '@src/integration/ai/signals/_engine/sink.ts';
import type { TemplateLoader } from '@src/integration/ai/prompts/_engine/template-loader.ts';
import { createFsTemplateLoader, defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { ReadinessProbeRegistry } from '@src/integration/ai/readiness/_engine/probe.ts';
import { claudeProbe } from '@src/integration/ai/readiness/claude/probe.ts';
import { codexProbe } from '@src/integration/ai/readiness/codex/probe.ts';
import { copilotProbe } from '@src/integration/ai/readiness/copilot/probe.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import { createEventBusLogger } from '@src/business/observability/event-bus-logger.ts';
import type { VersionChecker } from '@src/business/version/version-checker.ts';
import { createNpmVersionChecker } from '@src/integration/version/npm-version-checker.ts';
import { CLI_METADATA } from '@src/business/version/cli-metadata.ts';
import type { SkillsAdapter } from '@src/integration/ai/skills/_engine/skills-port.ts';
import type { SkillSource } from '@src/integration/ai/skills/_engine/skill-source.ts';
import { createSkillsAdapter } from '@src/integration/ai/skills/adapter-factory.ts';
import { createBundledSkillSource } from '@src/integration/ai/skills/bundled/source.ts';

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
   * Interactive AI session — used by refine and plan-interactive. Sibling of `provider`
   * (which is the headless variant). Each adapter handles its own mode; flows pick the one
   * matching their UX.
   */
  readonly interactiveAi: InteractiveAiProvider;
  /** AI session signal sink — structured `<learning>` / verdict / progress events. */
  readonly signals: HarnessSignalSink;
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
   * Source of canonical {@link Skill}s for a flow. Bundled-only in this PR; the same port
   * will host a user-skill source in a follow-up.
   */
  readonly skillSource: SkillSource;
}

/**
 * Injection points for `wire()`. Production paths come from `resolveStoragePaths()`; tests
 * build their own from a tmp directory via `storagePathsFromRoot(tmpDir)` so no test ever
 * touches the real `~/.ralphctl/` tree.
 *
 * Future injection points (AI session, signal sink, clock, logger) land here as they're
 * introduced — the test seam stays the same shape.
 */
export interface WireOptions {
  readonly storage: StoragePaths;
  readonly sinks: AppSinks;
  readonly settings: Settings;
  /**
   * Test seam threaded through {@link createAiProvider} into the Claude adapter. Production
   * leaves this `undefined` so the adapter spawns the real `claude` CLI; the wire integration
   * test passes a fake spawn so the test exercises the full wiring without a real binary.
   */
  readonly spawn?: ProviderSpawn;
}

/**
 * Build the wired dependency graph. Pure — does not touch the filesystem or `os`. Production
 * `main()` composes:
 *
 *     resolveStoragePaths() → ensureStorageRoots(paths) →
 *     createJsonSettingsRepository({ configRoot }).load() →
 *     wire({ storage: paths, sinks, settings })
 *
 * Tests skip the resolver and call `wire({ storage: storagePathsFromRoot(tmpDir).value, sinks,
 * settings: DEFAULT_SETTINGS })` directly. Same shape, different paths — the application code
 * under test is identical to production.
 */
/**
 * Default `Spawn` for general shell use (issue fetcher, interactive Claude binary). Falls
 * through to `node:child_process.spawn`. Tests can pass an alternative via `WireOptions.spawn`
 * — the same fake currently scripted for the headless provider.
 */
const defaultPipeSpawn: Spawn = (command, args, options) =>
  nodeSpawn(command, [...args], {
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
};

export const wire = (opts: WireOptions): AppDeps => {
  const spawn = (opts.spawn ?? defaultPipeSpawn) as unknown as Spawn;
  // One bus per `wire()` call — bus state isolates between concurrent app
  // instances. Adapters publish 'log' AppEvents directly; the bus is the
  // unified pipe TUI panels, file appenders, and webhooks all subscribe to.
  const eventBus = createInMemoryEventBus();
  const logger = createEventBusLogger({ eventBus, clock: IsoTimestamp.now });
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
  return {
    projectRepo: createFsProjectRepository({ root: opts.storage.dataRoot }),
    sprintRepo: createFsSprintRepository({ root: opts.storage.dataRoot }),
    sprintExecutionRepo: createFsSprintExecutionRepository({ root: opts.storage.dataRoot }),
    taskRepo: createFsTaskRepository({ root: opts.storage.dataRoot, fileLocker }),
    settings: opts.settings,
    settingsRepo: createJsonSettingsRepository({ configRoot: opts.storage.configRoot }),
    provider: createAiProvider({
      ai: opts.settings.ai,
      harnessConfig: opts.settings.harness,
      eventBus,
      ...(opts.spawn !== undefined ? { spawn: opts.spawn } : {}),
    }),
    gitRunner: createGitRunner(),
    shellScriptRunner: createShellScriptRunner(),
    fileLocker,
    writeFile: createAtomicWriteFile(),
    interactiveAi: createInteractiveAiProvider({ ai: opts.settings.ai, eventBus }),
    signals: opts.sinks.harness,
    templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
    clock: IsoTimestamp.now,
    probes: PROBES,
    eventBus,
    logger,
    pullRequestCreator: createPullRequestCreator({ gitRunner: createGitRunner(), spawn }),
    issueFetcher: createIssueFetcher({ spawn }),
    issuePusher: createIssuePusher({ spawn }),
    versionChecker: createNpmVersionChecker({
      stateRoot: opts.storage.stateRoot,
      currentVersion: CLI_METADATA.currentVersion,
      packageName: CLI_METADATA.packageName,
    }),
    skillsAdapter: createSkillsAdapter({ provider: opts.settings.ai.provider }),
    skillSource: createBundledSkillSource(),
  };
};
