import { z } from 'zod';
import type { AiSignal, DecisionSignal, IdeatedTicketsSignal, LearningSignal, NoteSignal } from '@src/domain/signal.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { decisionSignalSchema } from '@src/integration/ai/contract/_engine/signals/decision/schema.ts';
import { ideatedTicketsSignalSchema } from '@src/integration/ai/contract/_engine/signals/ideated-tickets/schema.ts';
import { learningSignalSchema } from '@src/integration/ai/contract/_engine/signals/learning/schema.ts';
import { noteSignalSchema } from '@src/integration/ai/contract/_engine/signals/note/schema.ts';
import { brandSignalArray } from '@src/integration/ai/contract/_engine/brand-signal-array.ts';
import type { AiOutputContract } from '@src/integration/ai/contract/_engine/types.ts';

/**
 * Per-leaf I/O contract for the ideate flow's interactive AI session — audit-[09]. The session
 * may emit:
 *
 *   - narrative fan-out: `learning`, `note`, `decision`
 *   - exactly one `ideated-tickets` carrying the AI's combined refine + plan output
 *
 * `ideated-tickets` is constrained to exactly one occurrence so the leaf has a single
 * deterministic payload to thread into `addApprovedTicketUseCase` + task append. The Zod
 * `refine` rejects a payload with zero or two `ideated-tickets` entries with a clear message.
 *
 * Sidecars: none. The structured payload is projected onto the sprint draft directly.
 *
 * Migration chain:
 *
 *   `migrations[0]` accepts the legacy top-level-array shape today's leaves synthesise (until
 *   Wave 6 lands the prompt-side contract and the AI writes the canonical wrapper itself) and
 *   wraps it into the `{ schemaVersion, signals }` shape the validator expects.
 */

type IdeateSignal = LearningSignal | NoteSignal | DecisionSignal | IdeatedTicketsSignal;

const exactlyOneIdeatedTickets = (signals: ReadonlyArray<{ readonly type: string }>): boolean =>
  signals.filter((s) => s.type === 'ideated-tickets').length === 1;

const signalsArraySchemaRaw = z
  .array(z.union([learningSignalSchema, noteSignalSchema, decisionSignalSchema, ideatedTicketsSignalSchema]))
  .refine(exactlyOneIdeatedTickets, 'exactly one ideated-tickets signal per ideate spawn');

/**
 * Cast bridge between Zod's inferred shape (optional fields widened to `T | undefined`
 * under `exactOptionalPropertyTypes`) and the strict-optional `IdeateSignal` union the
 * leaf consumes downstream. The runtime check is the source of truth.
 */
const signalsArraySchema = brandSignalArray<IdeateSignal>(signalsArraySchemaRaw);

/**
 * Legacy → v1 wrapping. Today's ideate leaf synthesises a bare top-level array of signals
 * from the AI's `ideate.json` body. Wave 6 swaps the prompt so the AI writes the
 * `{ schemaVersion, signals }` wrapper directly. Until then, this step shims the legacy shape.
 */
const wrapLegacyArray = (raw: unknown): unknown => {
  if (Array.isArray(raw)) return { schemaVersion: 1, signals: raw };
  return raw;
};

/** Static ISO timestamp embedded in the rendered example. Real spawns stamp `IsoTimestamp.now()`. */
const EXAMPLE_TS = '2026-05-22T10:00:00.000Z' as IsoTimestamp;

/**
 * Representative ideate payload. The required `ideated-tickets` carries the AI-authored
 * combined refine + plan envelope as a JSON string in `outputJson` — opaque to the contract
 * validator (parsed downstream by `parseIdeateOutput`).
 */
const ideateExampleSignals: readonly IdeateSignal[] = [
  {
    type: 'ideated-tickets',
    outputJson:
      '{"requirements":"# Export CSV\\n\\n## Problem\\n…","tasks":[{"name":"Wire endpoint","projectPath":"/abs/repo","steps":["…"],"verificationCriteria":["…"]}]}',
    timestamp: EXAMPLE_TS,
  },
];

/**
 * Ideate contract — audit-[09]. Composed only from `contract/_engine/` building blocks.
 */
export const ideateOutputContract: AiOutputContract<IdeateSignal> = {
  schemaVersion: 1,
  signalsSchema: signalsArraySchema,
  sidecars: [],
  migrations: {
    0: wrapLegacyArray,
  },
  exampleSignals: ideateExampleSignals,
};

/**
 * Exported solely so the test grid can assert against the exact signal sub-union the
 * contract accepts. The leaf consumes the contract via `ideateOutputContract`; this alias
 * must not appear outside `__tests__/`.
 *
 * @public
 */
export type IdeateContractSignal = IdeateSignal;

const _signalCheck: IdeateSignal extends AiSignal ? true : false = true;
void _signalCheck;
