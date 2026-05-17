import { z } from 'zod';
import {
  AbsolutePathSchema,
  RepositoryIdSchema,
  SlugSchema,
} from '@src/integration/persistence/shared/value-schemas.ts';

export const RepositorySchema = z.object({
  id: RepositoryIdSchema,
  slug: SlugSchema,
  name: z.string(),
  path: AbsolutePathSchema,
  checkScript: z.string().optional(),
  checkTimeout: z.number().optional(),
  setupScript: z.string().optional(),
  setupSkill: z.string().optional(),
  verifySkill: z.string().optional(),
});
