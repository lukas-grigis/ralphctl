import type { ProjectRepository } from '@src/domain/repository/project/project-repository.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { FindTasksBySprintId } from '@src/domain/repository/task/find-tasks-by-sprint-id.ts';
import type { WriteFile } from '@src/business/io/write-file.ts';

export interface ExportContextDeps {
  readonly sprintRepo: SprintRepository;
  readonly projectRepo: ProjectRepository;
  readonly taskRepo: FindTasksBySprintId;
  readonly writeFile: WriteFile;
}
