import { z } from 'zod';
import type { AiSignal, NoteSignal, ReproductionSignal } from '@src/domain/signal.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { noteSignalSchema } from '@src/integration/ai/contract/_engine/signals/note/schema.ts';
import { reproductionSignalSchema } from '@src/integration/ai/contract/_engine/signals/reproduction/schema.ts';
import { brandSignalArray } from '@src/integration/ai/contract/_engine/brand-signal-array.ts';
import type { AiOutputContract } from '@src/integration/ai/contract/_engine/types.ts';

/**
 * Per-leaf I/O contract for the `reproduce` one-shot session — a defect-shaped task's first
 * step, run before the generator turn. The session may emit:
 *
 *   - exactly one `reproduction` signal — the failing test it wrote, the command to run it, and
 *     the existing tests it judged relevant.
 *   - `note` (optional, free-form) — an operator-readable observation, e.g. why a particular
 *     reproduction shape was chosen over an alternative.
 *
 * `reproduction` is constrained to exactly one occurrence so the harness has a single
 * deterministic test/command pair to hand forward to the generator and evaluator turns.
 *
 * No sidecars — the reproduction test itself lives in the repository (the session wrote it with
 * its own Write tool, per the prompt's constraints). A derived sidecar over the validated signal
 * would just duplicate the file the harness can already read at `testPath`.
 *
 * Migration chain: empty. Fresh contract, no legacy on-disk shape to wrap.
 */

type ReproduceSignal = ReproductionSignal | NoteSignal;

const exactlyOneReproduction = (signals: ReadonlyArray<{ readonly type: string }>): boolean =>
  signals.filter((s) => s.type === 'reproduction').length === 1;

const signalsArraySchemaRaw = z
  .array(z.union([reproductionSignalSchema, noteSignalSchema]))
  .refine(exactlyOneReproduction, 'exactly one reproduction signal per reproduce spawn');

/**
 * Cast bridge between Zod's inferred shape (optional fields widened to `T | undefined` under
 * `exactOptionalPropertyTypes`) and the strict-optional `ReproduceSignal` union the leaf
 * consumes downstream. The runtime check is the source of truth; the cast just narrows the
 * static type so the contract's generic argument flows precisely through `validateSignalsFile`.
 */
const signalsArraySchema = brandSignalArray<ReproduceSignal>(signalsArraySchemaRaw);

/** Static ISO timestamp embedded in the rendered example. Real spawns stamp `IsoTimestamp.now()`. */
const EXAMPLE_TS = '2026-05-22T10:00:00.000Z' as IsoTimestamp;

/**
 * Representative reproduce payload — one `reproduction` signal plus an optional `note`
 * explaining a judgment call. Round-tripped through `signalsSchema` in the prompt unit tests.
 */
const reproduceExampleSignals: readonly ReproduceSignal[] = [
  {
    type: 'reproduction',
    testPath: 'tests/unit/business/foo/bar.test.ts',
    runCommand: '<test runner> run tests/unit/business/foo/bar.test.ts',
    observedFailure: 'expected 400, got 500\n  at src/routes/foo.ts:42',
    relevantTests: ['tests/unit/business/foo/baz.test.ts'],
    timestamp: EXAMPLE_TS,
  },
  {
    type: 'note',
    text: 'Reproduced via the existing empty-input test file rather than adding a new one, since the case fits there.',
    timestamp: EXAMPLE_TS,
  },
];

/**
 * Reproduce contract. Composed only from `contract/_engine/` building blocks.
 */
export const reproduceOutputContract: AiOutputContract<ReproduceSignal> = {
  schemaVersion: 1,
  signalsSchema: signalsArraySchema,
  sidecars: [],
  migrations: {},
  exampleSignals: reproduceExampleSignals,
};

/**
 * Exported solely so the test grid can assert against the exact signal sub-union the contract
 * accepts. The leaf consumes the contract via `reproduceOutputContract`; this alias must not
 * appear outside `__tests__/`.
 *
 * @public
 */
export type ReproduceContractSignal = ReproduceSignal;

const _signalCheck: ReproduceSignal extends AiSignal ? true : false = true;
void _signalCheck;
