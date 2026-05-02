/**
 * `buildTuiDeps` — extends `createTestDeps()` with the TUI-only ports
 * (`sessionManager`, `signalBus`, `logsBus`, `skillsSyncer`, `storage`,
 * `sessionId`) so a view test can call `setSharedDeps(buildTuiDeps())` and
 * render a real Ink view with a fully wired graph.
 *
 * Returns a `SharedDeps`-shaped object. The chain-test helper
 * (`createTestDeps`) covers business-port fakes; this layer adds the
 * presentation-only ports views read from `getSharedDeps()`.
 *
 * Usage:
 * ```ts
 * import { renderView } from '.../render-view.tsx';
 * const { lastFrame, deps, router } = renderView(<HomeView />, {
 *   sprints: [draft],
 *   evaluationIterations: 0,
 * });
 * ```
 */
import { Result } from '@src/domain/result.ts';
import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import { InMemorySignalBus } from '@src/integration/signals/bus.ts';
import { InMemoryLogEventBus } from '@src/integration/logging/log-event-bus.ts';
import type { SkillsSyncer } from '@src/integration/ai/skills/skills-syncer.ts';
import type { SessionSkillsLinker } from '@src/integration/ai/skills/session-skills-linker.ts';
import { resolveStoragePaths, type StoragePaths } from '@src/application/runtime/storage-paths-resolver.ts';
import type { SharedDeps } from '@src/application/bootstrap/shared-deps.ts';
import { createTestDeps, type TestDepsOptions } from './create-test-deps.ts';
import { FakeSessionManager } from './fake-session-manager.ts';

export interface TuiDepsOptions extends TestDepsOptions {
  /** Pre-built session manager. Defaults to a fresh {@link FakeSessionManager}. */
  readonly sessionManager?: FakeSessionManager;
}

/**
 * Bag returned to the test alongside the rendered frame so it can drive
 * assertions against the deps graph (e.g. "did the form save the sprint?").
 *
 * Mirrors {@link SharedDeps} but typed against the concrete fakes the helper
 * builds, so `deps.prompt.queueInput(...)` and `deps.sessionManager.startMock`
 * are reachable without unsafe casts.
 */
export interface TuiTestDeps extends SharedDeps {
  readonly sessionManager: FakeSessionManager;
}

const cacheSkillsDir = AbsolutePath.trustString('/tmp/ralphctl-test-skills');

class NoopSkillsSyncer implements SkillsSyncer {
  readonly cacheSkillsDir = cacheSkillsDir;
  syncDefaults(): ReturnType<SkillsSyncer['syncDefaults']> {
    return Promise.resolve(Result.ok());
  }
}

class NoopSessionSkillsLinker implements SessionSkillsLinker {
  link(): ReturnType<SessionSkillsLinker['link']> {
    return Promise.resolve(Result.ok());
  }
  unlink(): ReturnType<SessionSkillsLinker['unlink']> {
    return Promise.resolve(Result.ok());
  }
}

export function buildTuiDeps(opts: TuiDepsOptions = {}): TuiTestDeps {
  const inner = createTestDeps(opts);
  const sessionManager = opts.sessionManager ?? new FakeSessionManager();
  const signalBus = new InMemorySignalBus();
  const logsBus = new InMemoryLogEventBus();
  const storage: StoragePaths = resolveStoragePaths();
  const skillsSyncer = new NoopSkillsSyncer();
  const skillsLinker = new NoopSessionSkillsLinker();

  return {
    logger: inner.logger,
    logsBus,
    signalBus,
    signalParser: inner.signalParser,
    signalHandler: inner.signalHandler,
    aiSession: inner.aiSession,
    prompts: inner.prompts,
    external: inner.external,
    sprintRepo: inner.sprintRepo,
    projectRepo: inner.projectRepo,
    taskRepo: inner.taskRepo,
    configStore: inner.configStore,
    liveConfig: inner.liveConfig,
    storage,
    skillsSyncer,
    skillsLinker,
    sessionId: 'test-session',
    sessionManager,
    prompt: inner.prompt,
    rateLimitCoordinator: inner.rateLimitCoordinator,
  };
}
