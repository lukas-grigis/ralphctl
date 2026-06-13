import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';

export interface ExportContextInput {
  readonly sprintId: SprintId;
  /**
   * Optional project-id override. When omitted the flow uses the loaded sprint's own `projectId`
   * (every Sprint carries it). When supplied it is cross-checked against the sprint's `projectId`
   * and a mismatch is rejected — a one-character slip must not cross-wire the harness context that
   * is handed to AI agents.
   */
  readonly projectId?: ProjectId;
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
