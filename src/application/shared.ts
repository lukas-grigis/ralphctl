import type { RateLimitCoordinatorPort } from '@src/business/ports/rate-limit-coordinator.ts';
import { FilePersistenceAdapter } from '@src/integration/persistence/persistence-adapter.ts';
import { NodeFilesystemAdapter } from '@src/integration/filesystem-adapter.ts';
import { SignalParser } from '@src/integration/signals/parser.ts';
import { FileSystemSignalHandler } from '@src/integration/signals/file-system-handler.ts';
import { NoopSignalBus } from '@src/integration/signals/bus.ts';
import { InkPromptAdapter } from '@src/integration/ui/prompts/prompt-adapter.ts';
import { createLogger } from '@src/integration/logging/factory.ts';
import { RateLimitCoordinator } from '@src/integration/ai/session/rate-limiter.ts';
import { processLifecycleAdapter } from '@src/integration/ai/session/process-manager.ts';
import type { SharedDeps } from '@src/integration/shared-deps.ts';

// Re-export the type so existing callers that import `SharedDeps` from this
// module keep working. The shape itself lives in `@src/integration/shared-deps.ts`
// so integration modules can reference it without crossing the layer fence.
export type { SharedDeps };

/**
 * Create shared dependencies (called once at application startup).
 *
 * Callers may override individual ports — used by the Ink runtime to swap in
 * `InkPromptAdapter` + `InMemorySignalBus` + `InkSink` without rebuilding the
 * rest of the dependency graph.
 */
export function createSharedDeps(overrides: Partial<SharedDeps> = {}): SharedDeps {
  const persistence = overrides.persistence ?? new FilePersistenceAdapter();
  const filesystem = overrides.filesystem ?? new NodeFilesystemAdapter();
  const signalParser = overrides.signalParser ?? new SignalParser();
  const signalHandler = overrides.signalHandler ?? new FileSystemSignalHandler(persistence);
  const logger = overrides.logger ?? createLogger();
  const prompt = overrides.prompt ?? new InkPromptAdapter();
  const signalBus = overrides.signalBus ?? new NoopSignalBus();
  const createRateLimitCoordinator =
    overrides.createRateLimitCoordinator ?? ((): RateLimitCoordinatorPort => new RateLimitCoordinator());
  const processLifecycle = overrides.processLifecycle ?? processLifecycleAdapter;
  return {
    persistence,
    filesystem,
    signalParser,
    signalHandler,
    logger,
    prompt,
    signalBus,
    createRateLimitCoordinator,
    processLifecycle,
  };
}
