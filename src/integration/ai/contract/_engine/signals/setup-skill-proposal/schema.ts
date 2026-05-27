import { z } from 'zod';
import type { SetupSkillProposalSignal } from '@src/domain/signal.ts';
import { IsoTimestampSchema } from '@src/integration/persistence/shared/value-schemas.ts';
import type { Compatible } from '@src/integration/persistence/shared/codec-internal.ts';

/**
 * Zod schema for the `setup-skill-proposal` AI signal — readiness-flow body the harness
 * renders as `<sprintDir>/readiness/<repo-id>/setup-skill.md` and installs as
 * `<repo>/<parentDir>/skills/setup/SKILL.md` after operator approval.
 */
export const setupSkillProposalSignalSchema = z.object({
  type: z.literal('setup-skill-proposal'),
  content: z.string(),
  timestamp: IsoTimestampSchema,
});

const _typeCheck: Compatible<z.infer<typeof setupSkillProposalSignalSchema>, SetupSkillProposalSignal> = true;
void _typeCheck;
