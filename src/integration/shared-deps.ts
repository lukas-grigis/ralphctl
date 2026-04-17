import type { PersistencePort } from '@src/business/ports/persistence.ts';
import type { FilesystemPort } from '@src/business/ports/filesystem.ts';
import type { SignalParserPort } from '@src/business/ports/signal-parser.ts';
import type { SignalHandlerPort } from '@src/business/ports/signal-handler.ts';
import type { LoggerPort } from '@src/business/ports/logger.ts';
import type { PromptPort } from '@src/business/ports/prompt.ts';
import type { SignalBusPort } from '@src/business/ports/signal-bus.ts';
import type { RateLimitCoordinatorPort } from '@src/business/ports/rate-limit-coordinator.ts';
import type { ProcessLifecyclePort } from '@src/business/ports/process-lifecycle.ts';

/**
 * Shape of the adapter graph every command receives at runtime.
 *
 * Lives in the integration layer (not application) so both integration
 * modules (e.g. `bootstrap.ts`) and the application composition root can
 * reference the type without violating the inward-only dependency rule.
 * The concrete graph is constructed by `createSharedDeps` in
 * `src/application/shared.ts`.
 */
export interface SharedDeps {
  persistence: PersistencePort;
  filesystem: FilesystemPort;
  signalParser: SignalParserPort;
  signalHandler: SignalHandlerPort;
  logger: LoggerPort;
  prompt: PromptPort;
  signalBus: SignalBusPort;
  /**
   * Factory for the parallel-scheduler rate-limit coordinator. Business
   * pipelines call this per-execution so the concrete class (which is
   * integration-layer) never leaks into business imports.
   */
  createRateLimitCoordinator: () => RateLimitCoordinatorPort;
  /** SIGINT/SIGTERM handler installer + shutdown flag used by the scheduler. */
  processLifecycle: ProcessLifecyclePort;
}
