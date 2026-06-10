import { z } from 'zod';
import {
  AbsolutePathSchema,
  RepositoryIdSchema,
  SlugSchema,
} from '@src/integration/persistence/shared/value-schemas.ts';

/**
 * On-disk shape for one repository. The Zod schema accepts BOTH the new (`verifyScript` /
 * `verifyTimeout`) and the legacy (`checkScript` / `checkTimeout`) field names for the
 * v0.7.0 rename: legacy `project.json` files persisted before the rename must continue to
 * deserialize without a manual migration step.
 *
 * Deserialization rule (resolved in {@link normalizeRepositoryJson}): if a legacy key exists
 * and the new key is absent, the legacy value migrates to the new key; if both are present,
 * the new key wins. The serializer never emits legacy keys — a single round-trip drops them.
 */
export const RepositorySchema = z
  .object({
    id: RepositoryIdSchema,
    slug: SlugSchema,
    name: z.string(),
    path: AbsolutePathSchema,
    verifyScript: z.string().optional(),
    // Structured per-module verify gates (WS3). Optional field — round-trip safe, no
    // schemaVersion bump: a `project.json` persisted before this field existed simply omits it,
    // and a repo with no gates never writes the key (the entity factory drops an empty array).
    // The `''` catch-all prefix is permitted (it is the legacy `verifyScript` equivalent), so the
    // prefix is a plain string with no min-length floor.
    verifyGates: z
      .array(
        z.object({
          pathPrefix: z.string(),
          command: z.string(),
          timeoutMs: z.number().optional(),
        })
      )
      .readonly()
      .optional(),
    verifyTimeout: z.number().optional(),
    checkScript: z.string().optional(),
    checkTimeout: z.number().optional(),
    setupScript: z.string().optional(),
    setupSkill: z.string().optional(),
    verifySkill: z.string().optional(),
    suggestedSkills: z.array(z.string()).readonly().optional(),
  })
  .transform(({ checkScript, checkTimeout, verifyScript, verifyTimeout, ...rest }) => {
    // Legacy → new migration: when only the legacy field is present, lift its value onto the
    // canonical key. The legacy keys are stripped from the output so the rest of the system
    // sees a clean entity.
    const verify = verifyScript ?? checkScript;
    const timeout = verifyTimeout ?? checkTimeout;
    return {
      ...rest,
      ...(verify !== undefined ? { verifyScript: verify } : {}),
      ...(timeout !== undefined ? { verifyTimeout: timeout } : {}),
    };
  });
