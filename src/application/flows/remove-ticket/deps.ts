import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';

export interface TicketRemoveDeps {
  readonly sprintRepo: SprintRepository;
}
