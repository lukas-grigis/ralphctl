import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';

export interface ExportContextInput {
  readonly sprintId: SprintId;
  readonly projectId: ProjectId;
  readonly outputPath: AbsolutePath;
}

export interface ExportContextOutput {
  readonly outputPath: AbsolutePath;
  readonly byteCount: number;
}

export interface ExportContextCtx {
  readonly input: ExportContextInput;
  readonly output?: ExportContextOutput;
}
