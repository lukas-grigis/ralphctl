import type { PersistencePort } from '@src/domain/repositories/persistence.ts';
import type { FilesystemPort } from '@src/domain/repositories/filesystem.ts';
import type { SignalParserPort } from '@src/business/ports/signal-parser.ts';
import type { SignalHandlerPort } from '@src/business/ports/signal-handler.ts';
import type { LoggerPort } from '@src/business/ports/logger.ts';
import type { PromptPort } from '@src/business/ports/prompt.ts';
import type { SignalBusPort } from '@src/business/ports/signal-bus.ts';
import { FilePersistenceAdapter } from '@src/integration/persistence/persistence-adapter.ts';
import { NodeFilesystemAdapter } from '@src/integration/filesystem/filesystem-adapter.ts';
import { SignalParser } from '@src/integration/signals/parser.ts';
import { FileSystemSignalHandler } from '@src/integration/signals/file-system-handler.ts';
import { NoopSignalBus } from '@src/integration/signals/bus.ts';
import { InkPromptAdapter } from '@src/integration/prompts/prompt-adapter.ts';
import { createLogger } from '@src/integration/logging/factory.ts';

/** Dependencies shared across all commands, created eagerly at startup. */
export interface SharedDeps {
  persistence: PersistencePort;
  filesystem: FilesystemPort;
  signalParser: SignalParserPort;
  signalHandler: SignalHandlerPort;
  logger: LoggerPort;
  prompt: PromptPort;
  signalBus: SignalBusPort;
}

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
  return { persistence, filesystem, signalParser, signalHandler, logger, prompt, signalBus };
}
