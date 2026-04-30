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
import type { AiSessionPort } from '../../business/ports/ai-session-port.ts';
import type { ExternalPort } from '../../business/ports/external-port.ts';
import type { LoggerPort } from '../../business/ports/logger-port.ts';
import type { PromptBuilderPort } from '../../business/ports/prompt-builder-port.ts';
import type { SignalBusPort } from '../../business/ports/signal-bus-port.ts';
import type { SignalHandlerPort } from '../../business/ports/signal-handler-port.ts';
import type { SignalParserPort } from '../../business/ports/signal-parser-port.ts';
import type { PromptPort } from '../../business/ports/prompt-port.ts';
import type { ProjectRepository } from '../../domain/repositories/project-repository.ts';
import type { SprintRepository } from '../../domain/repositories/sprint-repository.ts';
import type { TaskRepository } from '../../domain/repositories/task-repository.ts';
import { TextPromptBuilderAdapter } from '../../integration/ai/prompts/prompt-builder-adapter.ts';
import { FileTemplateLoader } from '../../integration/ai/prompts/template-loader.ts';
import { ProviderAiSessionAdapter } from '../../integration/ai/session/provider-ai-session-adapter.ts';
import { NodeProcessRunner } from '../../integration/ai/session/process-runner.ts';
import {
  FileSessionSkillsLinker,
  type SessionSkillsLinker,
} from '../../integration/ai/skills/session-skills-linker.ts';
import { FileSkillsSyncer, type SkillsSyncer } from '../../integration/ai/skills/skills-syncer.ts';
import { CheckScriptRunner, DEFAULT_CHECK_TIMEOUT_MS } from '../../integration/external/check-script-runner.ts';
import { DefaultExternalAdapter } from '../../integration/external/external-adapter.ts';
import { GitOperations } from '../../integration/external/git-operations.ts';
import { NodeGitRunner } from '../../integration/external/git-runner.ts';
import { IssueFetcher } from '../../integration/external/issue-fetcher.ts';
import { InkSink } from '../../integration/logging/ink-sink.ts';
import { JsonLogger } from '../../integration/logging/json-logger.ts';
import { JsonlFileWriter } from '../../integration/logging/jsonl-file-writer.ts';
import { InMemoryLogEventBus, type LogEventBus } from '../../integration/logging/log-event-bus.ts';
import { PlainTextSink } from '../../integration/logging/plain-text-sink.ts';
import { FileLocker } from '../../integration/persistence/file-locker.ts';
import { FileProjectRepository } from '../../integration/persistence/file-project-repository.ts';
import { FileSprintRepository } from '../../integration/persistence/file-sprint-repository.ts';
import { FileTaskRepository } from '../../integration/persistence/file-task-repository.ts';
import { IsoTimestamp } from '../../domain/values/iso-timestamp.ts';
import { InMemorySignalBus } from '../../integration/signals/bus.ts';
import { FileSystemSignalHandler } from '../../integration/signals/file-system-handler.ts';
import { SignalParser } from '../../integration/signals/parser.ts';
import { FileConfigStore } from '../config/file-config-store.ts';
import type { ConfigStorePort } from '../config/config-store-port.ts';
import { FileLiveConfigReader, type LiveConfigReader } from '../runtime/live-config-reader.ts';
import { resolveStoragePaths, type StoragePaths } from '../runtime/storage-paths-resolver.ts';
import { generateSessionId } from '../runtime/session-id.ts';
import { SessionManager } from '../runtime/session-manager.ts';
import type { SessionManagerPort } from '../runtime/session-manager-port.ts';
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
      rateLimitListener: {
        onPaused: (reason, resumeAt) => {
          const at = resumeAt ? IsoTimestamp.parse(resumeAt.toISOString()) : null;
          signalBus.emit({
            type: 'rate-limit-paused',
            reason,
            ...(at?.ok ? { resumeAt: at.value } : {}),
          });
        },
        onResumed: () => {
          signalBus.emit({ type: 'rate-limit-resumed' });
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

  // ── Interactive prompts ──────────────────────────────────────────────────
  // Default adapter auto-mounts a minimal <PromptHost /> for one-shot CLI
  // commands. The Ink TUI mount path passes an override after entering the
  // alt-screen.
  let prompt: PromptPort;
  if (overrides.prompt !== undefined) {
    prompt = overrides.prompt;
  } else {
    // Lazy import to avoid pulling Ink into non-TUI paths at startup.
    const { InkPromptAdapter } = await import('../../integration/ui/prompts/prompt-adapter.ts');
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
  };
}
