import { z } from 'zod';
import type { VerifySkillProposalSignal } from '@src/domain/signal.ts';
import { IsoTimestampSchema } from '@src/integration/persistence/shared/value-schemas.ts';
import type { Compatible } from '@src/integration/persistence/shared/codec-internal.ts';

/**
 * Zod schema for the `verify-skill-proposal` AI signal — readiness-flow body the harness
 * renders as `<sprintDir>/readiness/<repo-id>/verify-skill.md` and installs as
 * `<repo>/<parentDir>/skills/verify/SKILL.md` after operator approval.
 */
/** @public */
export const verifySkillProposalSignalSchema = z.object({
  type: z.literal('verify-skill-proposal'),
  content: z.string(),
  timestamp: IsoTimestampSchema,
});

const _typeCheck: Compatible<z.infer<typeof verifySkillProposalSignalSchema>, VerifySkillProposalSignal> = true;
void _typeCheck;
