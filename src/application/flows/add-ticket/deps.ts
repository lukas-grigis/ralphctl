import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';

export interface TicketAddDeps {
  readonly sprintRepo: SprintRepository;
}
