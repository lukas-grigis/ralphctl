import { z } from 'zod';
import type {
  AiSignal,
  ChangeSignal,
  CommitMessageSignal,
  DecisionSignal,
  LearningSignal,
  NoteSignal,
  TaskBlockedSignal,
  TaskCompleteSignal,
  TaskVerifiedSignal,
} from '@src/domain/signal.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { changeSignalSchema } from '@src/integration/ai/contract/_engine/signals/change/schema.ts';
import { commitMessageSignalSchema } from '@src/integration/ai/contract/_engine/signals/commit-message/schema.ts';
import { decisionSignalSchema } from '@src/integration/ai/contract/_engine/signals/decision/schema.ts';
import { learningSignalSchema } from '@src/integration/ai/contract/_engine/signals/learning/schema.ts';
import { noteSignalSchema } from '@src/integration/ai/contract/_engine/signals/note/schema.ts';
import { taskBlockedSignalSchema } from '@src/integration/ai/contract/_engine/signals/task-blocked/schema.ts';
import { taskCompleteSignalSchema } from '@src/integration/ai/contract/_engine/signals/task-complete/schema.ts';
import { taskVerifiedSignalSchema } from '@src/integration/ai/contract/_engine/signals/task-verified/schema.ts';
import { brandSignalArray } from '@src/integration/ai/contract/_engine/brand-signal-array.ts';
import type { AiOutputContract, SidecarRule } from '@src/integration/ai/contract/_engine/types.ts';

/**
 * Per-leaf I/O contract for the gen-eval generator turn — audit-[09]. The generator may emit:
 *
 *   - narrative fan-out: `change`, `learning`, `note`, `decision`
 *   - task-lifecycle markers: `task-verified`, `task-complete`, `task-blocked`
 *   - one optional commit-message proposal for the `commit-task` leaf to consume
 *
 * `commit-message` is constrained to at most one occurrence per spawn so the harness has a
 * single deterministic commit message to thread into `commit-task`. The Zod `refine` rejects
 * a payload with two `commit-message` entries with a clear message; the leaf surfaces the
 * issue via `validateSignalsFile`.
 *
 * Sidecar layout:
 *
 *   `commit-message.txt` — `<subject>\n\n<body>\n` when `body` is present, else `<subject>\n`.
 *   Always optional: an attempt that produced no proposal leaves the round dir clean of the
 *   file. `commit-task` reads the message from ctx via the validated signal in memory, not
 *   from this file — the file is operator UX only.
 *
 * Migration chain:
 *
 *   `migrations[0]` wraps a legacy top-level-array payload into the `{ schemaVersion, signals }`
 *   shape the validator expects. The AI now writes the canonical wrapper directly via the
 *   prompt-side contract; the migration is inert for fresh sprints but stays in the chain to
 *   keep in-flight sprints on disk readable.
 */

type GeneratorSignal =
  | ChangeSignal
  | LearningSignal
  | NoteSignal
  | DecisionSignal
  | TaskVerifiedSignal
  | TaskCompleteSignal
  | TaskBlockedSignal
  | CommitMessageSignal;

const atMostOneCommitMessage = (signals: ReadonlyArray<{ readonly type: string }>): boolean =>
  signals.filter((s) => s.type === 'commit-message').length <= 1;

const signalsArraySchemaRaw = z
  .array(
    z.union([
      changeSignalSchema,
      learningSignalSchema,
      noteSignalSchema,
      decisionSignalSchema,
      taskVerifiedSignalSchema,
      taskCompleteSignalSchema,
      taskBlockedSignalSchema,
      commitMessageSignalSchema,
    ])
  )
  .refine(atMostOneCommitMessage, 'at most one commit-message signal per generator spawn');

/**
 * Cast bridge between Zod's inferred shape (optional fields widened to `T | undefined`
 * under `exactOptionalPropertyTypes`) and the strict-optional `GeneratorSignal` union the
 * leaf consumes downstream. The runtime check is the source of truth; the cast just
 * narrows the static type so the contract's generic argument flows precisely through
 * `validateSignalsFile` and `renderSidecars`.
 */
const signalsArraySchema = brandSignalArray<GeneratorSignal>(signalsArraySchemaRaw);

/**
 * Legacy → v1 wrapping. In-flight sprints on disk may carry a bare top-level array from an
 * earlier writer; fresh sprints write the `{ schemaVersion, signals }` wrapper directly. This
 * step shims the legacy shape into the wrapper the validator expects.
 */
const wrapLegacyArray = (raw: unknown): unknown => {
  if (Array.isArray(raw)) return { schemaVersion: 1, signals: raw };
  // Already-wrapped payloads (writer migrated, in-flight round on disk, …) pass through.
  // Anything else (object that's neither array nor wrapper, primitive) also passes through;
  // Zod will catch shape errors with a precise issue path.
  return raw;
};

/**
 * One sidecar per supported signal kind. Declaring each rule via the per-kind
 * `SidecarRule<K>` lets `extract` narrow to the matching variant of `AiSignal` at
 * authoring time. Storing the rules in the contract's `sidecars` array requires a cast
 * because `extract`'s parameter is contravariant — `SidecarRule<'commit-message'>` is
 * authored-narrow but not assignable to `SidecarRule<GeneratorSignal['type']>`. At runtime
 * `renderSidecars` filters by `signalKind` before calling `extract`, so the narrowing the
 * cast erases is preserved by the helper.
 */
const commitMessageSidecar: SidecarRule<'commit-message'> = {
  signalKind: 'commit-message',
  filename: 'commit-message.txt',
  multiplicity: 'optional',
  extract: (signal) => renderCommitMessage(signal),
};

/** Static ISO timestamp embedded in the rendered example. Real spawns stamp `IsoTimestamp.now()`. */
const EXAMPLE_TS = '2026-05-22T10:00:00.000Z' as IsoTimestamp;

/**
 * Representative payload for the prompt's rendered `{{OUTPUT_CONTRACT_SECTION}}` block. Covers
 * the kinds the generator most commonly emits — a narrative `change`, a `task-verified`
 * marker, and the optional `commit-message` proposal — so the AI sees a concrete shape it can
 * imitate. Round-tripped through `signalsSchema` in the prompt unit tests.
 */
const generatorExampleSignals: readonly GeneratorSignal[] = [
  { type: 'change', text: 'added foo helper', timestamp: EXAMPLE_TS },
  { type: 'task-verified', output: '$ pnpm test\n... 42 passed', timestamp: EXAMPLE_TS },
  {
    type: 'commit-message',
    subject: 'feat(foo): add helper for bar',
    body: 'Why: the call site repeated three times; centralising it removes a future drift hazard.',
    timestamp: EXAMPLE_TS,
  },
  { type: 'task-complete', timestamp: EXAMPLE_TS },
];

/**
 * Generator contract — audit-[09]. Composed only from `contract/_engine/` building blocks.
 */
export const generatorOutputContract: AiOutputContract<GeneratorSignal> = {
  schemaVersion: 1,
  signalsSchema: signalsArraySchema,
  // The cast is bounded: `commitMessageSidecar` is statically `SidecarRule<'commit-message'>`
  // and the helper dispatches by `signalKind`. See the comment block above.
  sidecars: [commitMessageSidecar as SidecarRule<GeneratorSignal['type']>],
  migrations: {
    0: wrapLegacyArray,
  },
  exampleSignals: generatorExampleSignals,
};

/**
 * Render a `commit-message` signal into the `commit-message.txt` body. Format mirrors
 * `git commit -F`'s expected layout: subject line, blank line, body, trailing newline.
 * Empty / absent `body` collapses to `<subject>\n` so a subject-only proposal still
 * round-trips cleanly.
 *
 * The harness's `fullMessage` extension field (added by `commit-task` post-trailer) is
 * intentionally NOT used here — sidecars are written at validation time, BEFORE the
 * commit-task leaf has had a chance to compute the final trailered message. The
 * resolved-trailer form lives only in the in-memory re-emitted signal the TUI surfaces.
 */
const renderCommitMessage = (signal: CommitMessageSignal): string => {
  const subject = signal.subject;
  const body = signal.body;
  if (body !== undefined && body.length > 0) return `${subject}\n\n${body}\n`;
  return `${subject}\n`;
};

/**
 * Exported solely so the test grid can assert against the exact signal sub-union the
 * contract accepts. The leaf consumes the contract via `generatorOutputContract`; this
 * alias must not appear outside `__tests__/`.
 *
 * @public
 */
export type GeneratorContractSignal = GeneratorSignal;

const _signalCheck: GeneratorSignal extends AiSignal ? true : false = true;
void _signalCheck;
