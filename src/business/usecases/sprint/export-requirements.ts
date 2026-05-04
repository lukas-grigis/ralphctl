/**
 * `ExportRequirementsUseCase` — write the sprint's refined requirements
 * to a markdown file.
 *
 * Source of truth: the canonical `<sprintDir>/requirements.json`
 * aggregate. This use case reads the JSON file at `aggregatePath` and
 * renders markdown — the sprint aggregate is never read directly. JSON
 * stays the only stored truth and a missing aggregate file (sprint not
 * yet refined) surfaces as a typed error.
 *
 * Path resolution lives in the caller (application / CLI layer) so
 * business code stays independent of the integration storage layout.
 */
import { readFile } from 'node:fs/promises';

import type { DomainError } from '@src/domain/errors/domain-error.ts';
import { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import { ValidationError } from '@src/domain/values/validation-error.ts';
import {
  type SprintRequirementsAggregate,
  renderSprintRequirementsMarkdown,
} from '@src/business/usecases/sprint/sprint-requirements-aggregate.ts';

export interface ExportRequirementsInput {
  /** Absolute path to the canonical `<sprintDir>/requirements.json`. */
  readonly aggregatePath: AbsolutePath;
  /** Where to write the rendered markdown. */
  readonly outputPath: AbsolutePath;
}

export interface ExportRequirementsOutput {
  readonly path: AbsolutePath;
  readonly byteCount: number;
}

export type WriteFileFn = (path: string, content: string) => Promise<void>;
export type ReadFileFn = (path: string) => Promise<string>;

export class ExportRequirementsUseCase {
  constructor(
    private readonly writeFile: WriteFileFn,
    private readonly readJsonFile: ReadFileFn = (p) => readFile(p, 'utf-8')
  ) {}

  async execute(input: ExportRequirementsInput): Promise<Result<ExportRequirementsOutput, DomainError>> {
    let raw: string;
    try {
      raw = await this.readJsonFile(String(input.aggregatePath));
    } catch (err) {
      return Result.error(
        new ValidationError({
          field: 'sprint.requirements',
          value: input.aggregatePath,
          message: `requirements aggregate not found at ${String(input.aggregatePath)} — run \`ralphctl sprint refine\` first (${err instanceof Error ? err.message : String(err)})`,
        })
      );
    }

    let agg: SprintRequirementsAggregate;
    try {
      agg = JSON.parse(raw) as SprintRequirementsAggregate;
    } catch (err) {
      return Result.error(
        new ValidationError({
          field: 'sprint.requirements',
          value: input.aggregatePath,
          message: `failed to parse ${String(input.aggregatePath)}: ${err instanceof Error ? err.message : String(err)}`,
        })
      );
    }

    const body = renderSprintRequirementsMarkdown(agg);
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
