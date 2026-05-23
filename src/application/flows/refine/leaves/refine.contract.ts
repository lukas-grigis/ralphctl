import { z } from 'zod';
import type { AiSignal, DecisionSignal, LearningSignal, NoteSignal, RefinedTicketSignal } from '@src/domain/signal.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { decisionSignalSchema } from '@src/integration/ai/contract/_engine/signals/decision/schema.ts';
import { learningSignalSchema } from '@src/integration/ai/contract/_engine/signals/learning/schema.ts';
import { noteSignalSchema } from '@src/integration/ai/contract/_engine/signals/note/schema.ts';
import { refinedTicketSignalSchema } from '@src/integration/ai/contract/_engine/signals/refined-ticket/schema.ts';
import type { AiOutputContract } from '@src/integration/ai/contract/_engine/types.ts';

/**
 * Per-leaf I/O contract for the refine flow's interactive AI session — audit-[09]. The session
 * may emit:
 *
 *   - narrative fan-out: `learning`, `note`, `decision`
 *   - exactly one `refined-ticket` carrying the AI's proposed requirements body
 *
 * `refined-ticket` is constrained to exactly one occurrence so the leaf has a single
 * deterministic body to thread into `refineTicketUseCase`. The Zod `refine` rejects a payload
 * with zero or two `refined-ticket` entries with a clear message; the leaf surfaces the issue
 * via `validateSignalsFile`.
 *
 * Sidecars: none. The body is projected onto the `Ticket` entity directly — no operator-facing
 * file is rendered. `renderSidecars` is still invoked (with an empty rule set) so the leaf's
 * post-validation control flow stays uniform with generator / evaluator / readiness.
 *
 * Migration chain:
 *
 *   `migrations[0]` accepts the legacy top-level-array shape today's leaves synthesise (until
 *   Wave 6 lands the prompt-side contract and the AI writes the canonical wrapper itself) and
 *   wraps it into the `{ schemaVersion, signals }` shape the validator expects.
 */

type RefineSignal = LearningSignal | NoteSignal | DecisionSignal | RefinedTicketSignal;

const exactlyOneRefinedTicket = (signals: ReadonlyArray<{ readonly type: string }>): boolean =>
  signals.filter((s) => s.type === 'refined-ticket').length === 1;

const signalsArraySchemaRaw = z
  .array(z.union([learningSignalSchema, noteSignalSchema, decisionSignalSchema, refinedTicketSignalSchema]))
  .refine(exactlyOneRefinedTicket, 'exactly one refined-ticket signal per refine spawn');

/**
 * Cast bridge between Zod's inferred shape (optional fields widened to `T | undefined`
 * under `exactOptionalPropertyTypes`) and the strict-optional `RefineSignal` union the
 * leaf consumes downstream. The runtime check is the source of truth; the cast just
 * narrows the static type so the contract's generic argument flows precisely through
 * `validateSignalsFile`.
 */
const signalsArraySchema = signalsArraySchemaRaw as unknown as z.ZodType<readonly RefineSignal[]>;

/**
 * Legacy → v1 wrapping. Today's refine leaf synthesises a bare top-level array of signals
 * from the AI's `requirements.md` body. Wave 6 swaps the prompt so the AI writes the
 * `{ schemaVersion, signals }` wrapper directly. Until then, this step shims the legacy
 * shape into the wrapper the validator expects.
 */
const wrapLegacyArray = (raw: unknown): unknown => {
  if (Array.isArray(raw)) return { schemaVersion: 1, signals: raw };
  // Already-wrapped payloads (writer migrated, fixture, …) pass through. Anything else
  // also passes through; Zod will catch shape errors with a precise issue path.
  return raw;
};

/** Static ISO timestamp embedded in the rendered example. Real spawns stamp `IsoTimestamp.now()`. */
const EXAMPLE_TS = '2026-05-22T10:00:00.000Z' as IsoTimestamp;

/**
 * Representative refine payload. The required `refined-ticket` carries the AI-authored
 * requirements body verbatim; the markdown content shape is left to operator convention.
 */
const refineExampleSignals: readonly RefineSignal[] = [
  {
    type: 'refined-ticket',
    body: '# Export to CSV\n\n## Problem\n\nUsers cannot move their data out of the app.\n\n## Acceptance criteria\n\n### AC1 — CSV export\n\n- **Given** a logged-in user, **When** they click Export, **Then** a CSV download starts.',
    timestamp: EXAMPLE_TS,
  },
];

/**
 * Refine contract — audit-[09]. Composed only from `contract/_engine/` building blocks.
 *
 * @public
 */
export const refineOutputContract: AiOutputContract<RefineSignal> = {
  schemaVersion: 1,
  signalsSchema: signalsArraySchema,
  sidecars: [],
  migrations: {
    0: wrapLegacyArray,
  },
  exampleSignals: refineExampleSignals,
};

/**
 * Exported solely so the test grid can assert against the exact signal sub-union the
 * contract accepts. The leaf consumes the contract via `refineOutputContract`; this alias
 * must not appear outside `__tests__/`.
 *
 * @public
 */
export type RefineContractSignal = RefineSignal;

const _signalCheck: RefineSignal extends AiSignal ? true : false = true;
void _signalCheck;
