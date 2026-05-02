/**
 * `ExportRequirementsUseCase` — write the sprint's refined requirements
 * to a markdown file.
 *
 * Output shape: one section per ticket. Tickets without `requirements`
 * (e.g. `pending` status) get a placeholder line so the reader sees them
 * listed but knows refinement hasn't run.
 */
import type { DomainError } from '@src/domain/errors/domain-error.ts';
import type { SprintRepository } from '@src/domain/repositories/sprint-repository.ts';
import { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import type { SprintId } from '@src/domain/values/sprint-id.ts';
import { ValidationError } from '@src/domain/values/validation-error.ts';
import type { Sprint } from '@src/domain/entities/sprint.ts';

export interface ExportRequirementsInput {
  readonly sprintId: SprintId;
  readonly outputPath: AbsolutePath;
}

export interface ExportRequirementsOutput {
  readonly path: AbsolutePath;
  readonly byteCount: number;
}

export type WriteFileFn = (path: string, content: string) => Promise<void>;

export class ExportRequirementsUseCase {
  constructor(
    private readonly sprints: SprintRepository,
    private readonly writeFile: WriteFileFn
  ) {}

  async execute(input: ExportRequirementsInput): Promise<Result<ExportRequirementsOutput, DomainError>> {
    const sprintR = await this.sprints.findById(input.sprintId);
    if (!sprintR.ok) return Result.error(sprintR.error);

    const body = renderRequirementsMarkdown(sprintR.value);
    try {
      await this.writeFile(String(input.outputPath), body);
    } catch (err) {
      return Result.error(
        new ValidationError({
          field: 'outputPath',
          value: input.outputPath,
          message: `failed to write requirements file: ${err instanceof Error ? err.message : String(err)}`,
        })
      );
    }
    return Result.ok({
      path: input.outputPath,
      byteCount: Buffer.byteLength(body, 'utf-8'),
    });
  }
}

/**
 * Render a sprint's requirements as Markdown. Pure function — exposed for
 * tests + the TUI preview.
 */
export function renderRequirementsMarkdown(sprint: Sprint): string {
  const lines: string[] = [];
  lines.push(`# Requirements — ${sprint.name}`);
  lines.push('');
  lines.push(`- Sprint id: \`${String(sprint.id)}\``);
  lines.push(`- Status: ${sprint.status}`);
  lines.push(`- Project: ${String(sprint.projectName)}`);
  if (sprint.affectedRepositories.length > 0) {
    lines.push('- Affected repositories:');
    for (const repo of sprint.affectedRepositories) {
      lines.push(`  - \`${String(repo)}\``);
    }
  }
  lines.push('');

  if (sprint.tickets.length === 0) {
    lines.push('_(no tickets)_');
    lines.push('');
    return lines.join('\n');
  }

  for (const ticket of sprint.tickets) {
    lines.push(`## ${ticket.title}`);
    lines.push('');
    lines.push(`- ID: \`${String(ticket.id)}\``);
    lines.push(`- Requirement status: ${ticket.requirementStatus}`);
    if (ticket.link !== undefined) lines.push(`- Link: ${ticket.link}`);
    lines.push('');
    if (ticket.description !== undefined) {
      lines.push('### Description');
      lines.push('');
      lines.push(ticket.description);
      lines.push('');
    }
    lines.push('### Requirements');
    lines.push('');
    if (ticket.requirements !== undefined && ticket.requirements.length > 0) {
      lines.push(ticket.requirements);
    } else {
      lines.push('_(not yet refined — run `ralphctl sprint refine`)_');
    }
    lines.push('');
  }
  return lines.join('\n');
}
