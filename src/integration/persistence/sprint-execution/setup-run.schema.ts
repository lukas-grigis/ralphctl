import { z } from 'zod';
import { IsoTimestampSchema, RepositoryIdSchema } from '@src/integration/persistence/shared/value-schemas.ts';

export const SetupRunSchema = z.object({
  repositoryId: RepositoryIdSchema,
  ranAt: IsoTimestampSchema,
});
