/**
 * `createTestDeps` — assemble a deterministic, fully in-memory subset of
 * {@link SharedDeps} for chain integration tests.
 *
 * This helper is the application-layer counterpart to the per-port fakes
 * under `src/business/_test-fakes/`. It glues those fakes together so
 * a chain factory test can spin up a working dependency graph in two lines:
 *
 * ```ts
 * const deps = createTestDeps({ sprints: [draftSprint] });
 * const flow = createRefineFlow(deps, { sprintId: draftSprint.id, cwd });
 * ```
 *
 * Only the ports the chain factories actually consume are included. Ports
 * the chains never reach for at construction time (signal bus, signal
 * handler, skills syncer, configStore for `evaluationIterations`, …) get
 * lightweight stand-ins, which keeps the test surface focused on chain
 * behaviour rather than on fake bookkeeping.
 *
 * Tests that need to override a single port can pass it via `overrides`;
 * everything else falls back to a pre-built fake.
 */
import { FakeAiSessionPort, type FakeAiSessionPortOptions } from '@src/business/_test-fakes/fake-ai-session-port.ts';
import { FakeExternalPort, type FakeExternalPortOptions } from '@src/business/_test-fakes/fake-external-port.ts';
import { FakeLoggerPort } from '@src/business/_test-fakes/fake-logger-port.ts';
import { FakePromptBuilderPort } from '@src/business/_test-fakes/fake-prompt-builder-port.ts';
import { FakeSignalBusPort } from '@src/business/_test-fakes/fake-signal-bus-port.ts';
import {
  FakeSignalParserPort,
  type FakeSignalParserOptions,
} from '@src/business/_test-fakes/fake-signal-parser-port.ts';
import { InMemoryProjectRepository } from '@src/business/_test-fakes/in-memory-project-repository.ts';
import { InMemorySprintRepository } from '@src/business/_test-fakes/in-memory-sprint-repository.ts';
import { InMemoryTaskRepository } from '@src/business/_test-fakes/in-memory-task-repository.ts';
import type { AiSessionPort } from '@src/business/ports/ai-session-port.ts';
import type { ExternalPort } from '@src/business/ports/external-port.ts';
import type { LoggerPort } from '@src/business/ports/logger-port.ts';
import type { PromptBuilderPort } from '@src/business/ports/prompt-builder-port.ts';
import type { PromptPort } from '@src/business/ports/prompt-port.ts';
import type { SignalBusPort } from '@src/business/ports/signal-bus-port.ts';
import type { SignalHandlerPort } from '@src/business/ports/signal-handler-port.ts';
import type { SignalParserPort } from '@src/business/ports/signal-parser-port.ts';
import { RateLimitCoordinator } from '@src/kernel/algorithms/rate-limit-coordinator.ts';
import type { Project } from '@src/domain/entities/project.ts';
import type { Sprint } from '@src/domain/entities/sprint.ts';
import type { Task } from '@src/domain/entities/task.ts';
import type { ProjectRepository } from '@src/domain/repositories/project-repository.ts';
import type { SprintRepository } from '@src/domain/repositories/sprint-repository.ts';
import type { TaskRepository } from '@src/domain/repositories/task-repository.ts';
import { Result } from '@src/domain/result.ts';
import type { SprintId } from '@src/domain/values/sprint-id.ts';
import type { ConfigStorePort } from '@src/application/config/config-store-port.ts';
import { CONFIG_DEFAULTS } from '@src/application/config/config-defaults.ts';
import type { Config } from '@src/application/config/config.ts';
import type { LiveConfigReader } from '@src/application/runtime/live-config-reader.ts';
import { FakePromptPort } from './fake-prompt-port.ts';

/**
 * Subset of `SharedDeps` the chain factories actually consume. Keep this
 * union narrow on purpose — anything outside this list is a chain layer
 * smell (e.g. reaching for a signal bus from inside a chain factory).
 */
export interface TestDeps {
  readonly sprintRepo: SprintRepository;
  readonly projectRepo: ProjectRepository;
  readonly taskRepo: TaskRepository;
  readonly aiSession: AiSessionPort;
  readonly prompts: PromptBuilderPort;
  readonly external: ExternalPort;
  readonly signalParser: SignalParserPort;
  readonly signalHandler: SignalHandlerPort;
  readonly logger: LoggerPort;
  readonly configStore: ConfigStorePort;
  readonly liveConfig: LiveConfigReader;
  readonly skillsLinker: TestSkillsLinker;
  readonly prompt: PromptPort;
  readonly signalBus: SignalBusPort;
  readonly rateLimitCoordinator: RateLimitCoordinator;
}

/**
 * The chain layer only calls `link(sessionDir, names)` and
 * `unlink(sessionDir)` on the skills linker — fake those two methods
 * inline rather than depending on the integration adapter.
 */
export interface TestSkillsLinker {
  link(sessionDir: string, skills: readonly string[]): Promise<Result<void, never>>;
  unlink(sessionDir: string): Promise<Result<void, never>>;
}

export interface TestDepsOptions {
  readonly sprints?: readonly Sprint[];
  readonly projects?: readonly Project[];
  readonly tasks?: readonly (readonly [SprintId, readonly Task[]])[];
  readonly aiSession?: FakeAiSessionPortOptions;
  readonly external?: FakeExternalPortOptions;
  readonly signalParser?: FakeSignalParserOptions;
  readonly evaluationIterations?: number;

  // Per-port overrides — when set, replaces the fake entirely.
  readonly overrides?: Partial<TestDeps>;
  /**
   * Optional pre-configured fake prompt port. When omitted, a fresh
   * `FakePromptPort` with no queued answers is used — any prompt firing
   * during the test will throw, surfacing the unexpected interaction.
   */
  readonly prompt?: PromptPort;
}

class NoopSkillsLinker implements TestSkillsLinker {
  link(): Promise<Result<void, never>> {
    return Promise.resolve(Result.ok());
  }
  unlink(): Promise<Result<void, never>> {
    return Promise.resolve(Result.ok());
  }
}

class NoopSignalHandler implements SignalHandlerPort {
  handle(): Promise<Result<void, never>> {
    return Promise.resolve(Result.ok());
  }
}

class StaticConfigStore implements ConfigStorePort {
  constructor(private readonly evaluationIterations: number) {}

  load(): ReturnType<ConfigStorePort['load']> {
    return Promise.resolve(
      Result.ok({
        ...CONFIG_DEFAULTS,
        evaluationIterations: this.evaluationIterations,
      })
    );
  }
  save(): ReturnType<ConfigStorePort['save']> {
    return Promise.resolve(Result.ok());
  }
}

class StaticLiveConfigReader implements LiveConfigReader {
  constructor(private readonly evaluationIterations: number) {}

  current(): Promise<Config> {
    return Promise.resolve({
      ...CONFIG_DEFAULTS,
      evaluationIterations: this.evaluationIterations,
    });
  }
}

export function createTestDeps(opts: TestDepsOptions = {}): TestDeps {
  const sprintRepo = opts.overrides?.sprintRepo ?? new InMemorySprintRepository(opts.sprints);
  const projectRepo = opts.overrides?.projectRepo ?? new InMemoryProjectRepository(opts.projects);
  const taskRepo = opts.overrides?.taskRepo ?? new InMemoryTaskRepository(opts.tasks);
  const aiSession = opts.overrides?.aiSession ?? new FakeAiSessionPort(opts.aiSession);
  const prompts = opts.overrides?.prompts ?? new FakePromptBuilderPort();
  const external = opts.overrides?.external ?? new FakeExternalPort(opts.external);
  const signalParser = opts.overrides?.signalParser ?? new FakeSignalParserPort(opts.signalParser);
  const signalHandler = opts.overrides?.signalHandler ?? new NoopSignalHandler();
  const logger = opts.overrides?.logger ?? new FakeLoggerPort();
  const configStore = opts.overrides?.configStore ?? new StaticConfigStore(opts.evaluationIterations ?? 1);
  const liveConfig = opts.overrides?.liveConfig ?? new StaticLiveConfigReader(opts.evaluationIterations ?? 1);
  const skillsLinker = opts.overrides?.skillsLinker ?? new NoopSkillsLinker();
  const prompt = opts.overrides?.prompt ?? opts.prompt ?? new FakePromptPort();
  const signalBus = opts.overrides?.signalBus ?? new FakeSignalBusPort();
  const rateLimitCoordinator = opts.overrides?.rateLimitCoordinator ?? new RateLimitCoordinator();

  return {
    sprintRepo,
    projectRepo,
    taskRepo,
    aiSession,
    prompts,
    external,
    signalParser,
    signalHandler,
    logger,
    configStore,
    liveConfig,
    skillsLinker,
    prompt,
    signalBus,
    rateLimitCoordinator,
  };
}
