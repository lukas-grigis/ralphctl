import { Result } from '@src/domain/result.ts';
import { renderSprintContextMarkdown } from '@src/business/sprint/views/context-md.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';

import type {
  ExportContextCtx,
  ExportContextInput,
  ExportContextOutput,
} from '@src/application/flows/export-context/ctx.ts';
import type { ExportContextDeps } from '@src/application/flows/export-context/deps.ts';

/**
 * Render the harness-context markdown (sprint + project + tasks) and write it to disk.
 * Linear: load × 3 → render → write.
 */
export const createExportContextFlow = (deps: ExportContextDeps): Element<ExportContextCtx> =>
  leaf<ExportContextCtx, ExportContextInput, ExportContextOutput>('export-context', {
    useCase: {
      async execute(input) {
        const sprint = await deps.sprintRepo.findById(input.sprintId);
        if (!sprint.ok) return Result.error(sprint.error);
        const project = await deps.projectRepo.findById(input.projectId);
        if (!project.ok) return Result.error(project.error);
        const tasks = await deps.taskRepo.findBySprintId(input.sprintId);
        if (!tasks.ok) return Result.error(tasks.error);

        const body = renderSprintContextMarkdown({
          sprint: sprint.value,
          project: project.value,
          tasks: tasks.value,
        });
        const written = await deps.writeFile(input.outputPath, body);
        if (!written.ok) return Result.error(written.error);
        return Result.ok({ outputPath: input.outputPath, byteCount: Buffer.byteLength(body, 'utf-8') });
      },
    },
    input: (c) => c.input,
    output: (c, o) => ({ ...c, output: o }),
  });
