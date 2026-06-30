import { z } from 'zod';
import type { AiSignal, PrContentSignal } from '@src/domain/signal.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { prContentSignalSchema } from '@src/integration/ai/contract/_engine/signals/pr-content/schema.ts';
import { brandSignalArray } from '@src/integration/ai/contract/_engine/brand-signal-array.ts';
import type { AiOutputContract, SidecarRule } from '@src/integration/ai/contract/_engine/types.ts';

/**
 * Per-leaf I/O contract for the create-pr flow's optional AI authoring step — audit-[09].
 *
 * Accepts ONLY `pr-content`. No narrative fan-out (`learning` / `note` / `decision`): the
 * create-pr session runs post-implement, after the sprint reaches review/done. There is no
 * active progress journal to enrich at that point — narrative signals would be silently
 * dropped on the floor, and the prompt instructs the AI to focus solely on authoring the PR
 * title + body.
 *
 * `pr-content` is constrained to exactly one occurrence so the leaf has a single
 * deterministic { title, body } to thread downstream.
 *
 * Sidecar: `pr-content.md` rendered as `# ${title}\n\n${body}` for operator review under
 * `<sprintDir>/create-pr/<run-slug>/`. The downstream `create-pr` leaf reads the proposal
 * off ctx, not from this file; the file is operator UX only.
 *
 * Migration chain: empty. This is a fresh contract introduced alongside the leaf; there is
 * no legacy on-disk shape to wrap.
 */

type CreatePrSignal = PrContentSignal;

const PR_CONTENT_KIND = 'pr-content';

const exactlyOnePrContent = (signals: ReadonlyArray<{ readonly type: string }>): boolean =>
  signals.filter((s) => s.type === PR_CONTENT_KIND).length === 1;

const signalsArraySchemaRaw = z
  .array(prContentSignalSchema)
  .refine(exactlyOnePrContent, 'exactly one pr-content signal per create-pr spawn');

/**
 * Cast bridge between Zod's inferred shape (optional fields widened to `T | undefined`
 * under `exactOptionalPropertyTypes`) and the strict-optional `CreatePrSignal` union the
 * leaf consumes downstream. The runtime check is the source of truth; the cast just
 * narrows the static type so the contract's generic argument flows precisely through
 * `validateSignalsFile`.
 */
const signalsArraySchema = brandSignalArray<CreatePrSignal>(signalsArraySchemaRaw);

const prContentSidecar: SidecarRule<'pr-content'> = {
  signalKind: PR_CONTENT_KIND,
  filename: 'pr-content.md',
  multiplicity: 'one',
  extract: (signal) => `# ${signal.title}\n\n${signal.body}`,
};

/** Static ISO timestamp embedded in the rendered example. Real spawns stamp `IsoTimestamp.now()`. */
const EXAMPLE_TS = '2026-05-23T10:00:00.000Z' as IsoTimestamp;

/**
 * Representative create-pr payload. The required `pr-content` carries an AI-authored title
 * and body; the markdown body shape is left to the prompt's "audience is project maintainers"
 * guidance.
 */
const createPrExampleSignals: readonly CreatePrSignal[] = [
  {
    type: PR_CONTENT_KIND,
    title: 'Add CSV export for transactions',
    body: 'Adds a CSV export action on the transactions list, mirroring the existing JSON export.\n\n## Changes\n\n- New export-csv use case + CLI flag.\n- Reuses the existing serialiser for column order.\n\n## Test plan\n\n- [ ] Manual: export 100 rows and diff against fixture.\n- [ ] Automated: unit tests for the serialiser.\n\nCloses #123',
    timestamp: EXAMPLE_TS,
  },
];

/**
 * create-pr contract — audit-[09]. Composed only from `contract/_engine/` building blocks.
 */
export const generatePrContentOutputContract: AiOutputContract<CreatePrSignal> = {
  schemaVersion: 1,
  signalsSchema: signalsArraySchema,
  sidecars: [prContentSidecar as SidecarRule<CreatePrSignal['type']>],
  migrations: {},
  exampleSignals: createPrExampleSignals,
};

/**
 * Exported solely so the test grid can assert against the exact signal sub-union the
 * contract accepts. The leaf consumes the contract via `generatePrContentOutputContract`;
 * this alias must not appear outside `__tests__/`.
 *
 * @public
 */
export type GeneratePrContentContractSignal = CreatePrSignal;

const _signalCheck: CreatePrSignal extends AiSignal ? true : false = true;
void _signalCheck;
