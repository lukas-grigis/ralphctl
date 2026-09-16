import { z } from 'zod';
import type { TaskBlockedSignal } from '@src/domain/signal.ts';
import { sanitizeDisplayText } from '@src/domain/value/display-text.ts';
import { IsoTimestampSchema } from '@src/integration/persistence/shared/value-schemas.ts';
import type { Compatible } from '@src/integration/persistence/shared/codec-internal.ts';

/**
 * Upper bound on one triage field — orders of magnitude above any real self-block explanation, so
 * genuine prose is never touched, while a runaway field cannot ride into `tasks.json` and every
 * surface that renders it. The whole-file cap (`validate-signals-file.ts`) is 4 MB, which one field
 * can otherwise fill on its own.
 */
const TRIAGE_TEXT_MAX_CHARS = 4000;

/**
 * Normalise ONE model-authored triage field at the trust boundary: strip terminal control
 * characters and clamp the length. Deliberately a transform, never a `.max()` REFUSAL —
 * `validate-signals-file` is all-or-nothing, so rejecting an over-long field would sink the whole
 * run (and with it every other signal the generator emitted) over a cosmetic problem. Render-side
 * sanitising stays in place regardless: rows written before this transform existed still carry
 * whatever the model wrote.
 */
const triageText = (): z.ZodType<string> =>
  z.string().transform((text) => sanitizeDisplayText(text, TRIAGE_TEXT_MAX_CHARS));

/**
 * Zod schema for the `task-blocked` AI signal — generator-emitted self-block reason. Drives
 * the task transition to `blocked` status; the reason becomes the audit row's body.
 *
 * `blockerClass` / `question` / `whatUnblocksMe` are OPTIONAL structured triage fields — a legacy
 * reason-only signal (every signal emitted before this shape existed) still validates unchanged.
 */
export const taskBlockedSignalSchema = z.object({
  type: z.literal('task-blocked'),
  reason: triageText(),
  blockerClass: z
    .union([z.literal('missing-information'), z.literal('ambiguous-request'), z.literal('contradictory-information')])
    .optional(),
  question: triageText().optional(),
  whatUnblocksMe: triageText().optional(),
  timestamp: IsoTimestampSchema,
});

const _typeCheck: Compatible<z.infer<typeof taskBlockedSignalSchema>, TaskBlockedSignal> = true;
void _typeCheck;
