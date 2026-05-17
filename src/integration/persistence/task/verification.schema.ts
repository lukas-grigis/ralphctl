import { z } from 'zod';

/**
 * Loader for `attempt.verification`. The current shape is a structural marker (`{}`); legacy
 * `tasks.json` written before the file-based provider refactor carried `{ output: string }`
 * with the full AI body. Both shapes parse and the legacy body field is silently dropped — the
 * AI's prose is no longer a first-class artifact on the attempt.
 *
 * `z.looseObject({})` accepts unknown keys (including the legacy `output`); the typed output
 * exposes `{}` only. Round-trip from current code emits no fields, so the persisted form is
 * also clean going forward.
 */
export const VerificationSchema = z.looseObject({}).transform(() => ({}) as Record<string, never>);
