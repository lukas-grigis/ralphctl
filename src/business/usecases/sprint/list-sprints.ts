import type { Sprint } from '@src/domain/entities/sprint.ts';
import type { DomainError } from '@src/domain/errors/domain-error.ts';
import type { SprintRepository } from '@src/domain/repositories/sprint-repository.ts';
import type { Result } from '@src/domain/result.ts';

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
