import { Result } from '@src/domain/result.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
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

        // Default the project to the sprint's own `projectId`. If the caller supplied an explicit
        // override it MUST match — a mismatch would render a context markdown describing the wrong
        // repo map, silently degrading every AI session that consumes it. Cross-check here (not in
        // the CLI) so the TUI launch path is protected too.
        if (input.projectId !== undefined && input.projectId !== sprint.value.projectId) {
          return Result.error(
            new ValidationError({
              field: 'project-id',
              value: input.projectId,
              message: `project id does not belong to sprint ${String(input.sprintId)} (sprint's project is ${String(sprint.value.projectId)})`,
            })
          );
        }
        const projectId = input.projectId ?? sprint.value.projectId;

        const project = await deps.projectRepo.findById(projectId);
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
