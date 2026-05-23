import { z } from 'zod';
import type {
  AiSignal,
  ChangeSignal,
  EvaluationSignal,
  LearningSignal,
  NoteSignal,
  TaskBlockedSignal,
  TaskVerifiedSignal,
} from '@src/domain/signal.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { changeSignalSchema } from '@src/integration/ai/contract/_engine/signals/change/schema.ts';
import { evaluationSignalSchema } from '@src/integration/ai/contract/_engine/signals/evaluation/schema.ts';
import { learningSignalSchema } from '@src/integration/ai/contract/_engine/signals/learning/schema.ts';
import { noteSignalSchema } from '@src/integration/ai/contract/_engine/signals/note/schema.ts';
import { taskBlockedSignalSchema } from '@src/integration/ai/contract/_engine/signals/task-blocked/schema.ts';
import { taskVerifiedSignalSchema } from '@src/integration/ai/contract/_engine/signals/task-verified/schema.ts';
import { renderEvaluationMarkdown } from '@src/integration/ai/contract/_engine/render-evaluation-markdown.ts';
import type { AiOutputContract, SidecarRule } from '@src/integration/ai/contract/_engine/types.ts';

/**
 * Per-leaf I/O contract for the gen-eval evaluator turn — audit-[09]. The evaluator may emit:
 *
 *   - narrative fan-out: `change`, `learning`, `note`
 *   - task-lifecycle markers: `task-verified`, `task-blocked`
 *   - exactly one `evaluation` signal carrying the verdict + per-dimension findings
 *
 * `evaluation` is constrained to exactly one occurrence per spawn so the harness has a single
 * deterministic verdict for the surrounding gen-eval loop to act on. The Zod `refine` rejects
 * a payload with zero or two `evaluation` entries with a clear message; the leaf surfaces the
 * issue via `validateSignalsFile`.
 *
 * Sidecar layout:
 *
 *   `evaluation.md` — operator-readable verdict rendered via {@link renderEvaluationMarkdown}.
 *   Multiplicity `'one'` mirrors the `exactlyOne` refinement: a passing payload always
 *   produces a rendered file. The downstream `runEvaluatorTurnUseCase` reads the verdict
 *   from the in-memory signal in ctx, not from this file — the file is operator UX only.
 *
 * Migration chain:
 *
 *   `migrations[0]` accepts the legacy top-level-array shape today's adapters still write
 *   (`parseHarnessSignals(...)`'s output verbatim) and wraps it into the `{ schemaVersion,
 *   signals }` shape the validator expects. Once Wave 6 lands the prompt-side contract and
 *   drops the stdout parser, the adapters will write the canonical wrapper directly and the
 *   migration becomes inert (but stays in the chain for in-flight sprints).
 */

type EvaluatorSignal =
  | ChangeSignal
  | LearningSignal
  | NoteSignal
  | TaskVerifiedSignal
  | TaskBlockedSignal
  | EvaluationSignal;

const exactlyOneEvaluation = (signals: ReadonlyArray<{ readonly type: string }>): boolean =>
  signals.filter((s) => s.type === 'evaluation').length === 1;

const signalsArraySchemaRaw = z
  .array(
    z.union([
      changeSignalSchema,
      learningSignalSchema,
      noteSignalSchema,
      taskVerifiedSignalSchema,
      taskBlockedSignalSchema,
      evaluationSignalSchema,
    ])
  )
  .refine(exactlyOneEvaluation, 'exactly one evaluation signal per evaluator spawn');

/**
 * Cast bridge between Zod's inferred shape (optional fields widened to `T | undefined`
 * under `exactOptionalPropertyTypes`) and the strict-optional `EvaluatorSignal` union the
 * leaf consumes downstream. The runtime check is the source of truth; the cast just
 * narrows the static type so the contract's generic argument flows precisely through
 * `validateSignalsFile` and `renderSidecars`.
 */
const signalsArraySchema = signalsArraySchemaRaw as unknown as z.ZodType<readonly EvaluatorSignal[]>;

/**
 * Legacy → v1 wrapping. Today's `HeadlessAiProvider` writes
 * `JSON.stringify(parseHarnessSignals(...))` — a bare top-level array. Wave 6 swaps the
 * prompt to ask the AI to write the `{ schemaVersion, signals }` wrapper directly. Until
 * then, this step shims the legacy shape into the wrapper the validator expects.
 */
const wrapLegacyArray = (raw: unknown): unknown => {
  if (Array.isArray(raw)) return { schemaVersion: 1, signals: raw };
  // Already-wrapped payloads (writer migrated, in-flight round on disk, …) pass through.
  // Anything else (object that's neither array nor wrapper, primitive) also passes through;
  // Zod will catch shape errors with a precise issue path.
  return raw;
};

/**
 * Sole sidecar — `evaluation.md`, rendered via the shared markdown formatter so the prompt-
 * side example and the leaf-side write share one renderer. `multiplicity: 'one'` mirrors the
 * `exactlyOne` refinement; if the schema's count-check were ever relaxed (it isn't), the
 * renderer would skip extras.
 */
const evaluationSidecar: SidecarRule<'evaluation'> = {
  signalKind: 'evaluation',
  filename: 'evaluation.md',
  multiplicity: 'one',
  extract: (signal) => renderEvaluationMarkdown(signal),
};

/** Static ISO timestamp embedded in the rendered example. Real spawns stamp `IsoTimestamp.now()`. */
const EXAMPLE_TS = '2026-05-22T10:00:00.000Z' as IsoTimestamp;

/**
 * Representative evaluator payload. One `evaluation` (the required verdict) plus a narrative
 * `note` shows the AI the shape it must produce. The Zod refine enforces exactly one
 * `evaluation`; the prompt unit test round-trips this example through the schema.
 */
const evaluatorExampleSignals: readonly EvaluatorSignal[] = [
  {
    type: 'evaluation',
    status: 'failed',
    dimensions: [
      { dimension: 'correctness', score: 5, passed: true, finding: 'all criteria met' },
      { dimension: 'completeness', score: 3, passed: false, finding: 'edge case missing' },
      { dimension: 'safety', score: 4, passed: true, finding: 'inputs validated' },
      { dimension: 'consistency', score: 5, passed: true, finding: 'matches sibling code' },
    ],
    overallScore: 4.3,
    critique: 'Completeness: add edge-case handling for empty input at src/foo.ts:23.',
    timestamp: EXAMPLE_TS,
  },
];

/**
 * Evaluator contract — audit-[09]. Composed only from `contract/_engine/` building blocks.
 *
 * @public
 */
export const evaluatorOutputContract: AiOutputContract<EvaluatorSignal> = {
  schemaVersion: 1,
  signalsSchema: signalsArraySchema,
  // The cast is bounded: `evaluationSidecar` is statically `SidecarRule<'evaluation'>` and
  // the helper dispatches by `signalKind`. Same shape rationale as the generator contract.
  sidecars: [evaluationSidecar as SidecarRule<EvaluatorSignal['type']>],
  migrations: {
    0: wrapLegacyArray,
  },
  exampleSignals: evaluatorExampleSignals,
};

/**
 * Exported solely so the test grid can assert against the exact signal sub-union the
 * contract accepts. The leaf consumes the contract via `evaluatorOutputContract`; this
 * alias must not appear outside `__tests__/`.
 *
 * @public
 */
export type EvaluatorContractSignal = EvaluatorSignal;

const _signalCheck: EvaluatorSignal extends AiSignal ? true : false = true;
void _signalCheck;
