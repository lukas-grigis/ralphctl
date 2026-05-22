import type { InteractivePrompt } from '@src/business/interactive/prompt.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { ProjectRepository } from '@src/domain/repository/project/project-repository.ts';
import type { SprintExecutionRepository } from '@src/domain/repository/sprint/sprint-execution-repository.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { AppendFile } from '@src/business/io/append-file.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';

/**
 * Narrow dependency contract for the create-sprint chain. Composition root constructs each field
 * from the integration layer (real repos, real `ConsolePrompt`, `IsoTimestamp.now`, log sink) and
 * passes the bag to `createCreateSprintFlow`.
 *
 * `clock` is injected so tests can pin the timestamp; production wires `IsoTimestamp.now`.
 */
export interface CreateSprintDeps {
  readonly projectRepo: ProjectRepository;
  readonly sprintRepo: SprintRepository;
  readonly sprintExecutionRepo: SprintExecutionRepository;
  readonly interactive: InteractivePrompt;
  readonly clock: () => IsoTimestamp;
  readonly eventBus: EventBus;
  readonly logger: Logger;
  /** Append adapter — used by `init-progress-journal` to write the per-sprint header. */
  readonly appendFile: AppendFile;
  /** Application data root — used by `init-progress-journal` to derive `<sprintDir>/progress.md`. */
  readonly dataRoot: AbsolutePath;
}
