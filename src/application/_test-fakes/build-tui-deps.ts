/**
 * `buildTuiDeps` — extends `createTestDeps()` with the TUI-only ports
 * (`sessionManager`, `signalBus`, `logsBus`, `skillsLinker`, `storage`,
 * `sessionId`) so a view test can call `setSharedDeps(buildTuiDeps())` and
 * render a real Ink view with a fully wired graph.
 *
 * Returns a `SharedDeps`-shaped object. The chain-test helper
 * (`createTestDeps`) covers business-port fakes; this layer adds the
 * presentation-only ports views read from `getSharedDeps()`.
 */
import { FakeSessionFolderBuilderPort } from '@src/business/_test-fakes/fake-session-folder-builder-port.ts';
import { Result } from '@src/domain/result.ts';
import { InMemorySignalBus } from '@src/integration/signals/bus.ts';
import { InMemoryLogEventBus } from '@src/integration/logging/log-event-bus.ts';
import type { BundledSkillsCopier } from '@src/integration/ai/skills/bundled-skills-copier.ts';
import { resolveStoragePaths, type StoragePaths } from '@src/application/runtime/storage-paths-resolver.ts';
import type { SharedDeps } from '@src/application/bootstrap/shared-deps.ts';
import { createTestDeps, type TestDepsOptions } from './create-test-deps.ts';
import { FakeSessionManager } from './fake-session-manager.ts';

export interface TuiDepsOptions extends TestDepsOptions {
  /** Pre-built session manager. Defaults to a fresh {@link FakeSessionManager}. */
  readonly sessionManager?: FakeSessionManager;
}

export interface TuiTestDeps extends SharedDeps {
  readonly sessionManager: FakeSessionManager;
}

class NoopBundledSkillsCopier implements BundledSkillsCopier {
  install(): ReturnType<BundledSkillsCopier['install']> {
    return Promise.resolve(Result.ok());
  }
  uninstall(): ReturnType<BundledSkillsCopier['uninstall']> {
    return Promise.resolve(Result.ok());
  }
}

export function buildTuiDeps(opts: TuiDepsOptions = {}): TuiTestDeps {
  const inner = createTestDeps(opts);
  const sessionManager = opts.sessionManager ?? new FakeSessionManager();
  const signalBus = new InMemorySignalBus();
  const logsBus = new InMemoryLogEventBus();
  const storage: StoragePaths = resolveStoragePaths();
  const skillsLinker = new NoopBundledSkillsCopier();

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
    skillsLinker,
    sessionId: 'test-session',
    sessionManager,
    prompt: inner.prompt,
    rateLimitCoordinator: inner.rateLimitCoordinator,
    writeContextFile: inner.writeContextFile,
    sessionFolderBuilder: new FakeSessionFolderBuilderPort(),
  };
}
