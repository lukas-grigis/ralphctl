import { z } from 'zod';
import type { AiSignal, DecisionSignal, LearningSignal, NoteSignal, RefinedTicketSignal } from '@src/domain/signal.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { decisionSignalSchema } from '@src/integration/ai/contract/_engine/signals/decision/schema.ts';
import { learningSignalSchema } from '@src/integration/ai/contract/_engine/signals/learning/schema.ts';
import { noteSignalSchema } from '@src/integration/ai/contract/_engine/signals/note/schema.ts';
import { refinedTicketSignalSchema } from '@src/integration/ai/contract/_engine/signals/refined-ticket/schema.ts';
import { brandSignalArray } from '@src/integration/ai/contract/_engine/brand-signal-array.ts';
import type { AiOutputContract } from '@src/integration/ai/contract/_engine/types.ts';

/**
 * Per-leaf I/O contract for the refine flow's interactive AI session — audit-[09]. The session
 * may emit:
 *
 *   - narrative fan-out: `learning`, `note`, `decision`
 *   - exactly one `refined-ticket` carrying the AI's proposed requirements body
 *
 * **Resilient by design — refine-only.** The `refined-ticket` is the sole essential output
 * (it projects onto the `Ticket` entity via `refineTicketUseCase`); `learning` / `note` /
 * `decision` are nice-to-haves fanned out to the EventBus for display. A drifting prompt or a
 * flaky model occasionally emits a malformed auxiliary signal (e.g. a `decision` carrying
 * `body` where the schema wants `text`). Under the shared strict-union validation a single
 * malformed auxiliary element used to fail the whole `safeParse`, silently discarding a
 * perfectly-good refinement. To prevent that, `signalsSchema` here parses **per element**:
 * each array entry is `safeParse`d against the four known signal schemas; failures are dropped
 * (the leaf logs a `warn` naming them — see {@link partitionRefineSignals}); valid entries are
 * kept. The `.refine` then enforces exactly one `refined-ticket` over the survivors.
 *
 * This leniency is deliberately local to the refine path — `validateSignalsFile` itself stays
 * strict for every other flow (implement / evaluate / readiness), which want hard rejection.
 *
 * `refined-ticket` is constrained to exactly one occurrence so the leaf has a single
 * deterministic body to thread into `refineTicketUseCase`. The `.refine` rejects a payload
 * whose survivors carry zero or two `refined-ticket` entries with a clear message; the leaf
 * surfaces the issue via `validateSignalsFile`. A malformed `refined-ticket` itself is dropped
 * by the per-element parse, which then trips the zero-`refined-ticket` rejection — a malformed
 * essential signal is a real failure the user must know about, not silently swallowed.
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

const refineSignalElementSchema = z.union([
  learningSignalSchema,
  noteSignalSchema,
  decisionSignalSchema,
  refinedTicketSignalSchema,
]);

const exactlyOneRefinedTicket = (signals: ReadonlyArray<{ readonly type: string }>): boolean =>
  signals.filter((s) => s.type === 'refined-ticket').length === 1;

/** One element dropped by {@link partitionRefineSignals} because it failed per-element parse. */
export interface DroppedRefineSignal {
  /** Zero-based index of the element in the on-disk `signals` array. */
  readonly index: number;
  /** The element's declared `type`, when it was a string — for the warn message. */
  readonly type: string | undefined;
  /** Compact reason (the Zod issue summary) for why the element was dropped. */
  readonly reason: string;
}

/**
 * Lenient per-element partition of a raw `signals` array. Each entry is `safeParse`d against
 * the four refine signal schemas; survivors land in `kept`, failures in `dropped` (carrying
 * the declared `type` and a compact reason for the leaf's warn log). The single source of
 * truth for the leniency — both `signalsSchema` and the leaf's warn path call through here so
 * "what the schema kept" and "what the leaf reports dropped" can never diverge.
 *
 * @public
 */
export const partitionRefineSignals = (
  raw: readonly unknown[]
): { readonly kept: readonly RefineSignal[]; readonly dropped: readonly DroppedRefineSignal[] } => {
  const kept: RefineSignal[] = [];
  const dropped: DroppedRefineSignal[] = [];
  raw.forEach((element, index) => {
    const parsed = refineSignalElementSchema.safeParse(element);
    if (parsed.success) {
      kept.push(parsed.data as RefineSignal);
      return;
    }
    const declaredType =
      typeof element === 'object' && element !== null && typeof (element as { type?: unknown }).type === 'string'
        ? (element as { type: string }).type
        : undefined;
    dropped.push({ index, type: declaredType, reason: parsed.error.issues[0]?.message ?? 'invalid signal shape' });
  });
  return { kept, dropped };
};

/**
 * Lenient signals schema — accepts any array, drops elements that fail per-element parse,
 * then enforces exactly one surviving `refined-ticket`. See the module doc for why this is
 * deliberately more forgiving than the shared strict-union path.
 */
const signalsArraySchemaRaw = z
  .array(z.unknown())
  .transform((raw) => partitionRefineSignals(raw).kept)
  .refine(exactlyOneRefinedTicket, 'exactly one refined-ticket signal per refine spawn');

/**
 * Cast bridge between Zod's inferred shape (optional fields widened to `T | undefined`
 * under `exactOptionalPropertyTypes`) and the strict-optional `RefineSignal` union the
 * leaf consumes downstream. The runtime check is the source of truth; the cast just
 * narrows the static type so the contract's generic argument flows precisely through
 * `validateSignalsFile`.
 */
const signalsArraySchema = brandSignalArray<RefineSignal>(signalsArraySchemaRaw);

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
