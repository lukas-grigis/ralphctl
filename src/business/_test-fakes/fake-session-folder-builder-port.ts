/**
 * `FakeSessionFolderBuilderPort` — non-IO fake of
 * {@link SessionFolderBuilderPort}.
 *
 * Returns deterministic per-unit paths drawn from a fixed root (no
 * filesystem touches) and records every call so chain tests can assert
 * on the inputs.
 */
import type {
  ExecutionUnitPaths,
  IdeationUnitPaths,
  PlanningFolderPaths,
  RefinementUnitPaths,
  SessionFolderBuilderPort,
} from '@src/business/ports/session-folder-builder-port.ts';
import type { AiProvider } from '@src/business/ports/ai-session-port.ts';
import type { Sprint } from '@src/domain/entities/sprint.ts';
import type { Task } from '@src/domain/entities/task.ts';
import type { Ticket } from '@src/domain/entities/ticket.ts';
import type { DomainError } from '@src/domain/errors/domain-error.ts';
import { Result } from '@src/domain/result.ts';
import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import type { TaskId } from '@src/domain/values/task-id.ts';
/**
 * Tiny inline slug — the real adapter uses
 * `integration/persistence/unit-slug.ts` (which the business layer can't
 * import). The fake doesn't need byte-for-byte parity with the real
 * implementation; it just needs deterministic, ASCII-safe folder names
 * for test assertions.
 */
function unitSlug(id: string, name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug.length > 0 ? `${id}-${slug}` : id;
}

export interface FakeSessionFolderBuilderOptions {
  readonly rootPrefix?: string;
  readonly failWith?: DomainError;
}

interface RefinementCall {
  readonly sprint: Sprint;
  readonly ticket: Ticket;
  readonly aiProvider: AiProvider;
}
interface IdeationCall {
  readonly sprint: Sprint;
  readonly ticket: Ticket;
  readonly aiProvider: AiProvider;
}
interface PlanningCall {
  readonly sprint: Sprint;
  readonly aiProvider: AiProvider;
}
interface ExecutionCall {
  readonly sprint: Sprint;
  readonly tasks: readonly Task[];
  readonly task: Task;
  readonly aiProvider: AiProvider;
  readonly priorEvaluations: ReadonlyMap<TaskId, string>;
}

export class FakeSessionFolderBuilderPort implements SessionFolderBuilderPort {
  readonly refinementCalls: RefinementCall[] = [];
  readonly ideationCalls: IdeationCall[] = [];
  readonly planningCalls: PlanningCall[] = [];
  readonly executionCalls: ExecutionCall[] = [];
  readonly refreshCalls: ExecutionCall[] = [];

  private readonly rootPrefix: string;

  constructor(private readonly opts: FakeSessionFolderBuilderOptions = {}) {
    this.rootPrefix = opts.rootPrefix ?? '/tmp/ralphctl-fake-units';
  }

  buildRefinementUnit(input: RefinementCall): Promise<Result<RefinementUnitPaths, DomainError>> {
    this.refinementCalls.push(input);
    if (this.opts.failWith) return Promise.resolve(Result.error(this.opts.failWith));
    const slug = unitSlug(String(input.ticket.id), input.ticket.title);
    const root = this.path(input.sprint.id, 'refinement', slug);
    return Promise.resolve(
      Result.ok({
        root,
        sessionMdPath: this.path(input.sprint.id, 'refinement', slug, 'session.md'),
        ticketMdPath: this.path(input.sprint.id, 'refinement', slug, 'ticket.md'),
        requirementsJsonPath: this.path(input.sprint.id, 'refinement', slug, 'requirements.json'),
      })
    );
  }

  buildIdeationUnit(input: IdeationCall): Promise<Result<IdeationUnitPaths, DomainError>> {
    this.ideationCalls.push(input);
    if (this.opts.failWith) return Promise.resolve(Result.error(this.opts.failWith));
    const slug = unitSlug(String(input.ticket.id), input.ticket.title);
    const root = this.path(input.sprint.id, 'ideation', slug);
    return Promise.resolve(
      Result.ok({
        root,
        sessionMdPath: this.path(input.sprint.id, 'ideation', slug, 'session.md'),
        ticketMdPath: this.path(input.sprint.id, 'ideation', slug, 'ticket.md'),
        outputJsonPath: this.path(input.sprint.id, 'ideation', slug, 'output.json'),
      })
    );
  }

  buildPlanningFolder(input: PlanningCall): Promise<Result<PlanningFolderPaths, DomainError>> {
    this.planningCalls.push(input);
    if (this.opts.failWith) return Promise.resolve(Result.error(this.opts.failWith));
    const root = this.path(input.sprint.id, 'planning');
    const addDirs = input.aiProvider === 'copilot' ? [] : [...input.sprint.affectedRepositories];
    return Promise.resolve(
      Result.ok({
        root,
        sessionMdPath: this.path(input.sprint.id, 'planning', 'session.md'),
        rawTasksJsonPath: this.path(input.sprint.id, 'planning', 'tasks.json'),
        addDirs,
      })
    );
  }

  buildExecutionUnit(input: ExecutionCall): Promise<Result<ExecutionUnitPaths, DomainError>> {
    this.executionCalls.push(input);
    if (this.opts.failWith) return Promise.resolve(Result.error(this.opts.failWith));
    const slug = unitSlug(String(input.task.id), input.task.name);
    const root = this.path(input.sprint.id, 'execution', slug);
    const isCopilot = input.aiProvider === 'copilot';
    return Promise.resolve(
      Result.ok({
        root,
        addDirs: isCopilot ? [] : [root],
        sessionCwd: isCopilot ? root : input.task.projectPath,
      })
    );
  }

  refreshExecutionUnit(input: ExecutionCall): Promise<Result<void, DomainError>> {
    this.refreshCalls.push(input);
    if (this.opts.failWith) return Promise.resolve(Result.error(this.opts.failWith));
    return Promise.resolve(Result.ok());
  }

  private path(sprintId: string, ...segments: string[]): AbsolutePath {
    return AbsolutePath.trustString([this.rootPrefix, sprintId, ...segments].join('/'));
  }
}
