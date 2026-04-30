import type { Sprint } from '../../../domain/entities/sprint.ts';
import type { DomainError } from '../../../domain/errors/domain-error.ts';
import type { SprintRepository } from '../../../domain/repositories/sprint-repository.ts';
import type { Result } from '../../../domain/result.ts';

/**
 * `ListSprintsUseCase` — enumerate every persisted sprint. Order is
 * implementation-defined by the repository.
 */
export class ListSprintsUseCase {
  constructor(private readonly sprints: SprintRepository) {}

  execute(): Promise<Result<readonly Sprint[], DomainError>> {
    return this.sprints.list();
  }
}
