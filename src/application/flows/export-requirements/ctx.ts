import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';

export interface ExportRequirementsInput {
  readonly sprintId: SprintId;
  readonly outputPath: AbsolutePath;
}

export interface ExportRequirementsOutput {
  readonly outputPath: AbsolutePath;
  readonly byteCount: number;
}

export interface ExportRequirementsCtx {
  readonly input: ExportRequirementsInput;
  readonly output?: ExportRequirementsOutput;
}
