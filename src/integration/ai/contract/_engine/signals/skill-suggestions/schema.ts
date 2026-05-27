import { z } from 'zod';
import type { SkillSuggestionsSignal } from '@src/domain/signal.ts';
import { IsoTimestampSchema } from '@src/integration/persistence/shared/value-schemas.ts';
import type { Compatible } from '@src/integration/persistence/shared/codec-internal.ts';

/**
 * Zod schema for the `skill-suggestions` AI signal — kebab-case skill names the AI
 * recommends linking into the agentic working directory. Empty `names` is the canonical
 * "no suggestions" state.
 */
export const skillSuggestionsSignalSchema = z.object({
  type: z.literal('skill-suggestions'),
  names: z.array(z.string()).readonly(),
  timestamp: IsoTimestampSchema,
});

const _typeCheck: Compatible<z.infer<typeof skillSuggestionsSignalSchema>, SkillSuggestionsSignal> = true;
void _typeCheck;
