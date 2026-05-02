/**
 * `createSharedDeps` — composition root for the next-architecture stack.
 *
 * Constructs every concrete adapter the runtime needs and wires them
 * together so use cases (which only see ports) can be invoked from CLI
 * commands, the Ink TUI, and tests with the same graph. Tests build a
 * focused subset by passing `overrides` for just the ports under test.
 *
 * Wiring rules:
 *  - `storage` defaults to `resolveStoragePaths()`. The root layout
 *    directories are created lazily on first write via
 *    `ensureLayoutDirsOnce` so read-only commands (`--version`, `--help`,
 *    `completion show`) don't materialise the data dir on disk.
 *  - `sessionId` defaults to `generateSessionId()` so the on-disk log
 *    filename is unique per process.
 *  - `logger` defaults to a `FanOutLogger` over (auto-detected console
 *    sink, `JsonlSink`) so every log event hits both the user-facing
 *    surface and `<logsDir>/<sessionId>.jsonl`. The console sink is
 *    selected by `RALPHCTL_JSON=1` / non-TTY (→ JsonLogger), `logSink:
 *    'ink'` (→ InkSink + LogEventBus), or default (→ PlainTextSink).
 *  - `aiSession` resolves the active provider lazily through
 *    `configStore.load()` — defaults to `'claude'` when the user has
 *    not chosen yet.
 *  - `sessionManager` is a fresh `SessionManager` per composition. It
 *    owns the registry of live `ChainRunner` instances; the CLI / TUI
 *    shutdown path is responsible for calling `dispose()` to abort
 *    every in-flight chain on exit.
 */
import type { AiSessionPort } from '@src/business/ports/ai-session-port.ts';
import type { ExternalPort } from '@src/business/ports/external-port.ts';
import type { LoggerPort } from '@src/business/ports/logger-port.ts';
import type { PromptBuilderPort } from '@src/business/ports/prompt-builder-port.ts';
import type { SignalBusPort } from '@src/business/ports/signal-bus-port.ts';
import type { SignalHandlerPort } from '@src/business/ports/signal-handler-port.ts';
import type { SignalParserPort } from '@src/business/ports/signal-parser-port.ts';
import type { PromptPort } from '@src/business/ports/prompt-port.ts';
import type { ProjectRepository } from '@src/domain/repositories/project-repository.ts';
import type { SprintRepository } from '@src/domain/repositories/sprint-repository.ts';
import type { TaskRepository } from '@src/domain/repositories/task-repository.ts';
import { RateLimitCoordinator } from '@src/kernel/algorithms/rate-limit-coordinator.ts';
import { TextPromptBuilderAdapter } from '@src/integration/ai/prompts/prompt-builder-adapter.ts';
import { FileTemplateLoader } from '@src/integration/ai/prompts/template-loader.ts';
import { ProviderAiSessionAdapter } from '@src/integration/ai/session/provider-ai-session-adapter.ts';
import { NodeProcessRunner } from '@src/integration/ai/session/process-runner.ts';
import { FileSessionSkillsLinker, type SessionSkillsLinker } from '@src/integration/ai/skills/session-skills-linker.ts';
import { FileSkillsSyncer, type SkillsSyncer } from '@src/integration/ai/skills/skills-syncer.ts';
import { CheckScriptRunner, DEFAULT_CHECK_TIMEOUT_MS } from '@src/integration/external/check-script-runner.ts';
import { DefaultExternalAdapter } from '@src/integration/external/external-adapter.ts';
import { GitOperations } from '@src/integration/external/git-operations.ts';
import { NodeGitRunner } from '@src/integration/external/git-runner.ts';
import { IssueFetcher } from '@src/integration/external/issue-fetcher.ts';
import { InkSink } from '@src/integration/logging/ink-sink.ts';
import { JsonLogger } from '@src/integration/logging/json-logger.ts';
import { JsonlFileWriter } from '@src/integration/logging/jsonl-file-writer.ts';
import { InMemoryLogEventBus, type LogEventBus } from '@src/integration/logging/log-event-bus.ts';
import { PlainTextSink } from '@src/integration/logging/plain-text-sink.ts';
import { FileLocker } from '@src/integration/persistence/file-locker.ts';
import { FileProjectRepository } from '@src/integration/persistence/file-project-repository.ts';
import { FileSprintRepository } from '@src/integration/persistence/file-sprint-repository.ts';
import { FileTaskRepository } from '@src/integration/persistence/file-task-repository.ts';
import { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';
import { InMemorySignalBus } from '@src/integration/signals/bus.ts';
import { FileSystemSignalHandler } from '@src/integration/signals/file-system-handler.ts';
import { SignalParser } from '@src/integration/signals/parser.ts';
import { FileConfigStore } from '@src/application/config/file-config-store.ts';
import type { ConfigStorePort } from '@src/application/config/config-store-port.ts';
import { FileLiveConfigReader, type LiveConfigReader } from '@src/application/runtime/live-config-reader.ts';
import { resolveStoragePaths, type StoragePaths } from '@src/application/runtime/storage-paths-resolver.ts';
import { generateSessionId } from '@src/application/runtime/session-id.ts';
import { SessionManager } from '@src/application/runtime/session-manager.ts';
import type { SessionManagerPort } from '@src/application/runtime/session-manager-port.ts';
import { FanOutLogger } from './fan-out-logger.ts';
import { JsonlSink } from './jsonl-sink.ts';

/**
 * Composition-root output. Every port a use case can consume is owned
 * here, plus the runtime metadata (storage paths, session id) the
 * application surfaces (CLI flags, doctor, Ink mount).
 */
export interface SharedDeps {
  readonly logger: LoggerPort;
  readonly logsBus: LogEventBus;
  readonly signalBus: SignalBusPort;
  readonly signalParser: SignalParserPort;
  readonly signalHandler: SignalHandlerPort;
  readonly aiSession: AiSessionPort;
  readonly prompts: PromptBuilderPort;
  readonly external: ExternalPort;
  readonly sprintRepo: SprintRepository;
  readonly projectRepo: ProjectRepository;
  readonly taskRepo: TaskRepository;
  readonly configStore: ConfigStorePort;
  /**
   * Live-reads the current config on demand so per-task settlement
   * picks up settings-panel edits without restart (REQ-12). Falls back
   * to {@link CONFIG_DEFAULTS} on read errors.
   */
  readonly liveConfig: LiveConfigReader;
  readonly storage: StoragePaths;
  readonly skillsSyncer: SkillsSyncer;
  readonly skillsLinker: SessionSkillsLinker;
  readonly sessionId: string;
  /**
   * Multi-chain registry. The CLI / TUI shutdown path must call
   * `sessionManager.dispose()` to abort every in-flight chain on exit.
   */
  readonly sessionManager: SessionManagerPort;
  /**
   * Interactive prompt adapter. The Ink TUI mount path swaps this to
   * `InkPromptAdapter`; plain-text CLI commands use the same adapter
   * which auto-mounts a minimal `<PromptHost />` on demand.
   */
  readonly prompt: PromptPort;
  /**
   * Global rate-limit coordinator shared by every per-task chain. The
   * chain's `wait-for-rate-limit` leaf awaits this before launching its
   * AI session; `ExecuteSingleTaskUseCase` pauses it when a spawn returns
   * a 429 hint so the rest of the parallel fan-out throttles in lock-step.
   * State changes broadcast on the signal bus via the listener wired
   * inside this composition root.
   */
  readonly rateLimitCoordinator: RateLimitCoordinator;
}

/** Console sink selector — chooses how user-facing log lines render. */
export type LogSinkSelector = 'plain-text' | 'json' | 'ink' | LoggerPort;

export interface SharedDepsOverrides {
  readonly storage?: StoragePaths;
  readonly sessionId?: string;
  readonly logger?: LoggerPort;
  readonly logsBus?: LogEventBus;
  readonly logSink?: LogSinkSelector;
  readonly signalBus?: SignalBusPort;
  readonly signalParser?: SignalParserPort;
  readonly signalHandler?: SignalHandlerPort;
  readonly aiSession?: AiSessionPort;
  readonly prompts?: PromptBuilderPort;
  readonly external?: ExternalPort;
  readonly sprintRepo?: SprintRepository;
  readonly projectRepo?: ProjectRepository;
  readonly taskRepo?: TaskRepository;
  readonly configStore?: ConfigStorePort;
  readonly liveConfig?: LiveConfigReader;
  readonly skillsSyncer?: SkillsSyncer;
  readonly skillsLinker?: SessionSkillsLinker;
  readonly sessionManager?: SessionManagerPort;
  readonly prompt?: PromptPort;
  readonly rateLimitCoordinator?: RateLimitCoordinator;
}

/**
 * Auto-detect the console sink shape when the caller didn't pick one
 * explicitly. Matches the legacy `createLogger()` policy:
 *  - `RALPHCTL_JSON=1` or non-TTY stdout → `JsonLogger`.
 *  - Default → `PlainTextSink`.
 *
 * Ink-mounted runs always pass `logSink: 'ink'` from the mount path —
 * we never auto-detect it.
 */
function defaultSinkSelector(): 'plain-text' | 'json' {
  if (process.env['RALPHCTL_JSON']) return 'json';
  if (typeof process.stdout.isTTY === 'boolean' && !process.stdout.isTTY) {
    return 'json';
  }
  return 'plain-text';
}

/**
 * Resolve the default check-script timeout in milliseconds. Honors
 * `RALPHCTL_SETUP_TIMEOUT_MS` (legacy parity — the value is documented in
 * CLAUDE.md). Invalid / non-positive values fall back to the runner default
 * so a typo doesn't accidentally disable the timeout.
 *
 * Exported so the bootstrap test can assert on env-var handling without
 * having to introspect the private adapter graph.
 */
export function resolveCheckTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['RALPHCTL_SETUP_TIMEOUT_MS'];
  if (raw === undefined || raw.trim() === '') return DEFAULT_CHECK_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_CHECK_TIMEOUT_MS;
  return parsed;
}

function buildConsoleSink(selector: LogSinkSelector, logsBus: LogEventBus): LoggerPort {
  if (typeof selector !== 'string') return selector;
  switch (selector) {
    case 'plain-text':
      return new PlainTextSink();
    case 'json':
      return new JsonLogger();
    case 'ink':
      return new InkSink(logsBus);
  }
}

export async function createSharedDeps(overrides: SharedDepsOverrides = {}): Promise<SharedDeps> {
  // ── Storage ──────────────────────────────────────────────────────
  // Layout dirs are created lazily on the first write via
  // `ensureLayoutDirsOnce` (see file-* repositories + FileConfigStore).
  // Read-only commands never reach a write path so they never touch disk.
  const storage = overrides.storage ?? resolveStoragePaths();

  // ── Session id ───────────────────────────────────────────────────
  const sessionId = overrides.sessionId ?? generateSessionId();

  // ── Logging ──────────────────────────────────────────────────────
  // Order matters: build the logs bus before the Ink sink can subscribe,
  // and keep the JSONL writer outside the sink composition so callers
  // can dispose it explicitly on shutdown.
  const logsBus = overrides.logsBus ?? new InMemoryLogEventBus();

  let logger: LoggerPort;
  if (overrides.logger !== undefined) {
    logger = overrides.logger;
  } else {
    const selector = overrides.logSink ?? defaultSinkSelector();
    const consoleSink = buildConsoleSink(selector, logsBus);
    const writer = new JsonlFileWriter({
      sessionId,
      logsDir: storage.logsDir,
    });
    logger = new FanOutLogger([consoleSink, new JsonlSink(writer)]);
  }

  // ── Persistence ──────────────────────────────────────────────────
  const fileLocker = new FileLocker();
  const sprintRepo = overrides.sprintRepo ?? new FileSprintRepository(storage, fileLocker, logger);
  const projectRepo = overrides.projectRepo ?? new FileProjectRepository(storage, fileLocker);
  const taskRepo = overrides.taskRepo ?? new FileTaskRepository(storage, fileLocker);
  const configStore = overrides.configStore ?? new FileConfigStore(storage, fileLocker);
  const liveConfig = overrides.liveConfig ?? new FileLiveConfigReader(configStore);

  // ── Signals ──────────────────────────────────────────────────────
  const signalParser = overrides.signalParser ?? new SignalParser();
  const signalHandler = overrides.signalHandler ?? new FileSystemSignalHandler(storage, fileLocker);
  const signalBus = overrides.signalBus ?? new InMemorySignalBus();

  // ── External ─────────────────────────────────────────────────────
  let external: ExternalPort;
  if (overrides.external !== undefined) {
    external = overrides.external;
  } else {
    const gitRunner = new NodeGitRunner();
    external = new DefaultExternalAdapter(
      new GitOperations(gitRunner),
      // Honor RALPHCTL_SETUP_TIMEOUT_MS (legacy parity) so users can
      // raise the default 5-minute cap on slow / monorepo check scripts
      // without a code change.
      new CheckScriptRunner(resolveCheckTimeoutMs(process.env)),
      new IssueFetcher(gitRunner)
    );
  }

  // ── AI session + prompts ─────────────────────────────────────────
  const aiSession =
    overrides.aiSession ??
    new ProviderAiSessionAdapter({
      process: new NodeProcessRunner(),
      // Lazy provider resolution — read fresh on first session spawn so
      // mid-process provider changes via the settings panel apply
      // without a restart. Defaults to 'claude' when the user has not
      // picked one yet; the doctor flags this with a warn.
      getProvider: async () => {
        const loaded = await configStore.load();
        if (!loaded.ok) return 'claude';
        return loaded.value.aiProvider ?? 'claude';
      },
      // Bridge the provider's per-spawn rate-limit recovery into the live
      // signal bus so the TUI dashboard can render a countdown banner.
      // The matching pause/resume log lines surface in the recent-events
      // panel so users on the plain-text CLI also see the recovery.
      rateLimitListener: {
        onPaused: (reason, resumeAt) => {
          const at = resumeAt ? IsoTimestamp.parse(resumeAt.toISOString()) : null;
          signalBus.emit({
            type: 'rate-limit-paused',
            reason,
            ...(at?.ok ? { resumeAt: at.value } : {}),
          });
          logger.warn(`rate limit hit — pausing new task launches${reason ? `: ${reason}` : ''}`);
        },
        onResumed: () => {
          signalBus.emit({ type: 'rate-limit-resumed' });
          logger.success('rate limit cleared, resuming task launches');
        },
      },
    });

  const prompts = overrides.prompts ?? new TextPromptBuilderAdapter(new FileTemplateLoader());

  // ── Skills ───────────────────────────────────────────────────────
  const skillsSyncer = overrides.skillsSyncer ?? new FileSkillsSyncer({ cacheDir: storage.cacheDir });
  const skillsLinker =
    overrides.skillsLinker ?? new FileSessionSkillsLinker({ cacheSkillsDir: skillsSyncer.cacheSkillsDir });

  // ── Session manager ──────────────────────────────────────────────
  // Multi-chain registry. One SessionManager per composition. Use
  // cases that spawn long-running chains (execute, refine, plan, …)
  // register their `ChainRunner` here so the TUI can list / attach /
  // kill them like tmux windows.
  const sessionManager = overrides.sessionManager ?? new SessionManager();

  // ── Rate-limit coordinator ────────────────────────────────────────
  // Global pause / resume primitive shared across every in-flight
  // per-task chain. ExecuteSingleTaskUseCase calls `pause()` when a spawn
  // returns a 429 hint; the per-task chain's `wait-for-rate-limit` leaf
  // awaits `waitUntilResumed()` before launching its own AI session so
  // the whole parallel fan-out throttles in lock-step.
  //
  // Bridge state changes to the signal bus so the live dashboard's
  // RateLimitBanner reacts uniformly whether the pause came from the
  // adapter's per-spawn retry loop (already wired above) or from the
  // use case at the chain layer.
  const rateLimitCoordinator = overrides.rateLimitCoordinator ?? new RateLimitCoordinator();
  rateLimitCoordinator.subscribe((event) => {
    if (event.type === 'paused') {
      const at = event.resumeAt ? IsoTimestamp.parse(event.resumeAt.toISOString()) : null;
      signalBus.emit({
        type: 'rate-limit-paused',
        reason: event.reason,
        ...(at?.ok ? { resumeAt: at.value } : {}),
      });
      logger.warn(`rate limit hit — pausing new task launches${event.reason ? `: ${event.reason}` : ''}`);
    } else {
      signalBus.emit({ type: 'rate-limit-resumed' });
      logger.success('rate limit cleared, resuming task launches');
    }
  });

  // ── Interactive prompts ──────────────────────────────────────────────────
  // Default adapter auto-mounts a minimal <PromptHost /> for one-shot CLI
  // commands. The Ink TUI mount path passes an override after entering the
  // alt-screen.
  let prompt: PromptPort;
  if (overrides.prompt !== undefined) {
    prompt = overrides.prompt;
  } else {
    // Lazy import to avoid pulling Ink into non-TUI paths at startup.
    const { InkPromptAdapter } = await import('@src/integration/ui/prompts/prompt-adapter.ts');
    prompt = new InkPromptAdapter();
  }

  return {
    logger,
    logsBus,
    signalBus,
    signalParser,
    signalHandler,
    aiSession,
    prompts,
    external,
    sprintRepo,
    projectRepo,
    taskRepo,
    configStore,
    liveConfig,
    storage,
    skillsSyncer,
    skillsLinker,
    sessionId,
    sessionManager,
    prompt,
    rateLimitCoordinator,
  };
}
