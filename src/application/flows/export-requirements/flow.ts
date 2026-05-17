import { Result } from '@src/domain/result.ts';
import { renderSprintRequirementsMarkdown } from '@src/business/sprint/views/requirements-md.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';

import type {
  ExportRequirementsCtx,
  ExportRequirementsInput,
  ExportRequirementsOutput,
} from '@src/application/flows/export-requirements/ctx.ts';
import type { ExportRequirementsDeps } from '@src/application/flows/export-requirements/deps.ts';

/**
 * Render the sprint's approved-ticket requirements to markdown and write to disk.
 * Linear: load → render → write.
 */
export const createExportRequirementsFlow = (deps: ExportRequirementsDeps): Element<ExportRequirementsCtx> =>
  leaf<ExportRequirementsCtx, ExportRequirementsInput, ExportRequirementsOutput>('export-requirements', {
    useCase: {
      async execute(input) {
        const sprint = await deps.sprintRepo.findById(input.sprintId);
        if (!sprint.ok) return Result.error(sprint.error);
        const body = renderSprintRequirementsMarkdown(sprint.value);
        const written = await deps.writeFile(input.outputPath, body);
        if (!written.ok) return Result.error(written.error);
        return Result.ok({ outputPath: input.outputPath, byteCount: Buffer.byteLength(body, 'utf-8') });
      },
    },
    input: (c) => c.input,
    output: (c, o) => ({ ...c, output: o }),
  });
