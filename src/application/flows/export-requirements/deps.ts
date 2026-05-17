import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { WriteFile } from '@src/business/io/write-file.ts';

export interface ExportRequirementsDeps {
  readonly sprintRepo: SprintRepository;
  readonly writeFile: WriteFile;
}
