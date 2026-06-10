import { z } from 'zod';
import type { VerifyGatesSignal } from '@src/domain/signal.ts';
import { IsoTimestampSchema } from '@src/integration/persistence/shared/value-schemas.ts';
import type { Compatible } from '@src/integration/persistence/shared/codec-internal.ts';

/**
 * Zod schema for the `verify-gates` AI signal — structured per-module verify gates the
 * `detect-scripts` flow proposes for monorepo-style repositories. ADDITIVE to `verify-script`:
 * the AI emits this only for repos with distinct module roots, alongside the legacy single-line
 * `verify-script` fallback.
 *
 * Field names are pinned to the persistence-layer `verifyGates` shape (`repository.schema.ts`)
 * and the domain `VerifyGate` value object so the proposal round-trips onto
 * `Repository.verifyGates` unchanged:
 *
 *   - `gates`      — non-empty array (an empty array is rejected: the AI omits the signal for
 *     single-module repos rather than emitting `gates: []`).
 *   - `pathPrefix` — POSIX-style prefix relative to the repo root; `''` is the catch-all. Plain
 *     string, no min-length floor (the catch-all needs the empty value).
 *   - `command`    — verbatim shell line for the module.
 *   - `timeoutMs`  — optional per-gate wall-clock cap.
 *
 * Strictness note: the per-gate object is NOT `.strict()` — it mirrors the other signal schemas
 * (extra keys are ignored, not rejected) so a forward-compatible AI emission with an unknown
 * field still validates. A gate MISSING `command` or `pathPrefix` is dropped by the whole-parse
 * (the field is required), matching the project's strict field-name convention: the template's
 * documented contract and this schema name the same keys literally.
 */
export const verifyGatesSignalSchema = z.object({
  type: z.literal('verify-gates'),
  gates: z
    .array(
      z.object({
        pathPrefix: z.string(),
        command: z.string(),
        timeoutMs: z.number().optional(),
      })
    )
    .nonempty()
    .readonly(),
  timestamp: IsoTimestampSchema,
});

const _typeCheck: Compatible<z.infer<typeof verifyGatesSignalSchema>, VerifyGatesSignal> = true;
void _typeCheck;
