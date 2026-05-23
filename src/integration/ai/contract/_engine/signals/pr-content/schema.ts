import { z } from 'zod';
import type { PrContentSignal } from '@src/domain/signal.ts';
import { IsoTimestampSchema } from '@src/integration/persistence/shared/value-schemas.ts';
import type { Compatible } from '@src/integration/persistence/shared/codec-internal.ts';

/**
 * Zod schema for the `pr-content` AI signal — produced by the create-pr flow's optional AI
 * authoring step. Carries an AI-authored PR title + body the harness threads into
 * `gh pr create` / `glab mr create`.
 *
 * Closed for modification (OCP): future PR-authoring extensions (labels, reviewers,
 * draft-rationale, …) MUST land as additional signal kinds — never by widening this one.
 */
/** @public */
export const prContentSignalSchema = z.object({
  type: z.literal('pr-content'),
  title: z.string(),
  body: z.string(),
  timestamp: IsoTimestampSchema,
});

const _typeCheck: Compatible<z.infer<typeof prContentSignalSchema>, PrContentSignal> = true;
void _typeCheck;
