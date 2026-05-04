/**
 * `FileSessionFolderBuilderAdapter` — thin orchestrator that implements
 * `SessionFolderBuilderPort` by delegating to the four phase-specific
 * builder modules.
 *
 * Each module owns the materialisation logic for its sandbox layout:
 *   - `refine-unit-builder.ts` — per-ticket refinement folder
 *   - `ideate-unit-builder.ts` — per-ticket ideation folder
 *   - `planning-folder-builder.ts` — single per-sprint planning folder
 *   - `execution-unit-builder.ts` — per-task evaluator folder (+ refresh)
 *
 * Shared low-level helpers (file I/O, context-file renderer, ticket input
 * renderer) live in `session-folder-helpers.ts`.
 *
 * The public surface of this class — method signatures, return types —
 * must stay in sync with `SessionFolderBuilderPort` in
 * `src/business/ports/session-folder-builder-port.ts`.
 */
import type { AiProvider } from '@src/business/ports/ai-session-port.ts';
import type {
  ExecutionUnitPaths,
  IdeationUnitPaths,
  PlanningFolderPaths,
  RefinementUnitPaths,
  SessionFolderBuilderPort,
} from '@src/business/ports/session-folder-builder-port.ts';
import type { LoggerPort } from '@src/business/ports/logger-port.ts';
import type { Sprint } from '@src/domain/entities/sprint.ts';
import type { Task } from '@src/domain/entities/task.ts';
import type { Ticket } from '@src/domain/entities/ticket.ts';
import type { DomainError } from '@src/domain/errors/domain-error.ts';
import type { Result } from '@src/domain/result.ts';
import type { TaskId } from '@src/domain/values/task-id.ts';
import { buildExecutionUnit, refreshExecutionUnit } from '@src/integration/persistence/execution-unit-builder.ts';
import { buildIdeationUnit } from '@src/integration/persistence/ideate-unit-builder.ts';
import { buildPlanningFolder } from '@src/integration/persistence/planning-folder-builder.ts';
import { buildRefinementUnit } from '@src/integration/persistence/refine-unit-builder.ts';
import type { StoragePaths } from '@src/integration/persistence/storage-paths.ts';

export class FileSessionFolderBuilderAdapter implements SessionFolderBuilderPort {
  constructor(
    private readonly storage: StoragePaths,
    private readonly logger?: LoggerPort
  ) {}

  buildRefinementUnit(input: {
    readonly sprint: Sprint;
    readonly ticket: Ticket;
    readonly aiProvider: AiProvider;
  }): Promise<Result<RefinementUnitPaths, DomainError>> {
    return buildRefinementUnit(this.storage, input);
  }

  buildIdeationUnit(input: {
    readonly sprint: Sprint;
    readonly ticket: Ticket;
    readonly aiProvider: AiProvider;
  }): Promise<Result<IdeationUnitPaths, DomainError>> {
    return buildIdeationUnit(this.storage, input);
  }

  buildPlanningFolder(input: {
    readonly sprint: Sprint;
    readonly aiProvider: AiProvider;
  }): Promise<Result<PlanningFolderPaths, DomainError>> {
    return buildPlanningFolder(this.storage, input);
  }

  buildExecutionUnit(input: {
    readonly sprint: Sprint;
    readonly tasks: readonly Task[];
    readonly task: Task;
    readonly aiProvider: AiProvider;
    readonly priorEvaluations: ReadonlyMap<TaskId, string>;
  }): Promise<Result<ExecutionUnitPaths, DomainError>> {
    const logger = this.logger;
    return buildExecutionUnit(this.storage, {
      ...input,
      onWarn:
        logger !== undefined
          ? (msg) => {
              logger.warn(msg);
            }
          : undefined,
    });
  }

  refreshExecutionUnit(input: {
    readonly sprint: Sprint;
    readonly tasks: readonly Task[];
    readonly task: Task;
    readonly aiProvider: AiProvider;
    readonly priorEvaluations: ReadonlyMap<TaskId, string>;
  }): Promise<Result<void, DomainError>> {
    return refreshExecutionUnit(this.storage, input);
  }
}
