import { z } from 'zod';
import type { Result } from '@src/domain/result.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { Repository } from '@src/domain/entity/repository.ts';
import type { ParseError } from '@src/domain/value/error/parse-error.ts';
import { ProjectIdSchema, SlugSchema } from '@src/integration/persistence/shared/value-schemas.ts';
import { RepositorySchema } from '@src/integration/persistence/project/repository.schema.ts';
import { type Compatible, safeParseToResult } from '@src/integration/persistence/shared/codec-internal.ts';

const IssueOriginRefSchema = z.object({
  provider: z.union([z.literal('github'), z.literal('gitlab')]),
  owner: z.string().min(1),
  repo: z.string().min(1),
});

export const ProjectSchema = z.object({
  id: ProjectIdSchema,
  slug: SlugSchema,
  displayName: z.string(),
  description: z.string().optional(),
  repositories: z.array(RepositorySchema).readonly(),
  defaultIssueOrigin: IssueOriginRefSchema.optional(),
});

export const fromJsonProject = (input: unknown): Result<Project, ParseError> =>
  safeParseToResult<Project, typeof ProjectSchema>(ProjectSchema, input);

export const toJsonProject = (project: Project): unknown => project;

type _checkRepository = Compatible<Repository, z.infer<typeof RepositorySchema>>;
type _checkProject = Compatible<Project, z.infer<typeof ProjectSchema>>;
const _typeChecks: [_checkRepository, _checkProject] = [true, true];
void _typeChecks;
