import { z } from 'zod';
import type { CandidateSelectionSignal } from '@src/domain/signal.ts';
import { IsoTimestampSchema } from '@src/integration/persistence/shared/value-schemas.ts';
import type { Compatible } from '@src/integration/persistence/shared/codec-internal.ts';

/**
 * Zod schema for the `candidate-selection` AI signal — the best-of-N judge's verdict comparing
 * two candidates' compact structured summaries (arXiv 2604.16529). `winner` is the 1-based index
 * matching the `Candidate 1` / `Candidate 2` labelling the prompt shows the AI; constrained to a
 * positive integer so a downstream consumer can index the candidate array directly.
 */
export const candidateSelectionSignalSchema = z.object({
  type: z.literal('candidate-selection'),
  winner: z.number().int().positive(),
  rationale: z.string(),
  timestamp: IsoTimestampSchema,
});

const _typeCheck: Compatible<z.infer<typeof candidateSelectionSignalSchema>, CandidateSelectionSignal> = true;
void _typeCheck;
