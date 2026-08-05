import { z } from 'zod';
import type { AiSignal, CandidateSelectionSignal } from '@src/domain/signal.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { candidateSelectionSignalSchema } from '@src/integration/ai/contract/_engine/signals/candidate-selection/schema.ts';
import { brandSignalArray } from '@src/integration/ai/contract/_engine/brand-signal-array.ts';
import type { AiOutputContract, SidecarRule } from '@src/integration/ai/contract/_engine/types.ts';

/**
 * Per-leaf I/O contract for the `select-candidate` one-shot judge session — best-of-N candidate
 * selection over compact structured summaries (arXiv 2604.16529). Keeps ONLY
 * `candidate-selection`: the session's whole job is a pairwise verdict over the two summaries it
 * is shown, so no narrative fan-out is accepted — a stray `note` / `learning` a mounted skill
 * might coach fails the array the same as an omitted or duplicated verdict.
 *
 * `candidate-selection` is constrained to exactly one occurrence so the harness has a single
 * deterministic winner index to act on.
 *
 * Sidecar: `candidate-selection.md` rendered as `# Winner: Candidate <n>\n\n<rationale>` for
 * operator review. The downstream leaf reads the verdict off ctx, not from this file.
 *
 * Migration chain: empty. Fresh contract, no legacy on-disk shape to wrap.
 */

type SelectCandidateSignal = CandidateSelectionSignal;

const CANDIDATE_SELECTION_KIND = 'candidate-selection';

const exactlyOneCandidateSelection = (signals: ReadonlyArray<{ readonly type: string }>): boolean =>
  signals.filter((s) => s.type === CANDIDATE_SELECTION_KIND).length === 1;

const signalsArraySchemaRaw = z
  .array(candidateSelectionSignalSchema)
  .refine(exactlyOneCandidateSelection, 'exactly one candidate-selection signal per select-candidate spawn');

/**
 * Cast bridge between Zod's inferred shape (optional fields widened to `T | undefined` under
 * `exactOptionalPropertyTypes`) and the strict-optional `SelectCandidateSignal` type the leaf
 * consumes downstream. The runtime check is the source of truth; the cast just narrows the
 * static type so the contract's generic argument flows precisely through `validateSignalsFile`
 * and `renderSidecars`.
 */
const signalsArraySchema = brandSignalArray<SelectCandidateSignal>(signalsArraySchemaRaw);

/** Sole sidecar — an operator-readable rendering of the winner + rationale. */
const candidateSelectionSidecar: SidecarRule<'candidate-selection'> = {
  signalKind: CANDIDATE_SELECTION_KIND,
  filename: 'candidate-selection.md',
  multiplicity: 'one',
  extract: (signal) => `# Winner: Candidate ${String(signal.winner)}\n\n${signal.rationale}`,
};

/** Static ISO timestamp embedded in the rendered example. Real spawns stamp `IsoTimestamp.now()`. */
const EXAMPLE_TS = '2026-05-22T10:00:00.000Z' as IsoTimestamp;

/**
 * Representative select-candidate payload — the judge's verdict citing concrete evidence from
 * both summaries. Round-tripped through `signalsSchema` in the prompt unit tests.
 */
const selectCandidateExampleSignals: readonly SelectCandidateSignal[] = [
  {
    type: CANDIDATE_SELECTION_KIND,
    winner: 2,
    rationale:
      'Candidate 2 ran the reproduction command and cited the passing output, and its changed-files list stayed ' +
      'within the declared scope. Candidate 1 claims completion without citing a verification run and also edited ' +
      'an unrelated middleware file.',
    timestamp: EXAMPLE_TS,
  },
];

/**
 * select-candidate contract. Composed only from `contract/_engine/` building blocks.
 */
export const selectCandidateOutputContract: AiOutputContract<SelectCandidateSignal> = {
  schemaVersion: 1,
  signalsSchema: signalsArraySchema,
  sidecars: [candidateSelectionSidecar as SidecarRule<SelectCandidateSignal['type']>],
  migrations: {},
  exampleSignals: selectCandidateExampleSignals,
};

/**
 * Exported solely so the test grid can assert against the exact signal type the contract
 * accepts. The leaf consumes the contract via `selectCandidateOutputContract`; this alias must
 * not appear outside `__tests__/`.
 *
 * @public
 */
export type SelectCandidateContractSignal = SelectCandidateSignal;

const _signalCheck: SelectCandidateSignal extends AiSignal ? true : false = true;
void _signalCheck;
