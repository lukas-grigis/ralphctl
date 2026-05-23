import { z } from 'zod';
import type { AiSignal, DecisionSignal, LearningSignal, NoteSignal, TaskPlanSignal } from '@src/domain/signal.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { decisionSignalSchema } from '@src/integration/ai/contract/_engine/signals/decision/schema.ts';
import { learningSignalSchema } from '@src/integration/ai/contract/_engine/signals/learning/schema.ts';
import { noteSignalSchema } from '@src/integration/ai/contract/_engine/signals/note/schema.ts';
import { taskPlanSignalSchema } from '@src/integration/ai/contract/_engine/signals/task-plan/schema.ts';
import type { AiOutputContract } from '@src/integration/ai/contract/_engine/types.ts';

/**
 * Per-leaf I/O contract for the plan flow's interactive AI session — audit-[09]. The session
 * may emit:
 *
 *   - narrative fan-out: `learning`, `note`, `decision`
 *   - exactly one `task-plan` carrying the AI's structured planner output
 *
 * `task-plan` is constrained to exactly one occurrence so the leaf has a single deterministic
 * payload to thread into `planSprintUseCase`. The Zod `refine` rejects a payload with zero or
 * two `task-plan` entries with a clear message.
 *
 * Sidecars: none. The structured payload is projected onto the sprint's task list directly —
 * no operator-facing file is rendered.
 *
 * Migration chain:
 *
 *   `migrations[0]` accepts the legacy top-level-array shape today's leaves synthesise (until
 *   Wave 6 lands the prompt-side contract and the AI writes the canonical wrapper itself) and
 *   wraps it into the `{ schemaVersion, signals }` shape the validator expects.
 */

type PlanSignal = LearningSignal | NoteSignal | DecisionSignal | TaskPlanSignal;

const exactlyOneTaskPlan = (signals: ReadonlyArray<{ readonly type: string }>): boolean =>
  signals.filter((s) => s.type === 'task-plan').length === 1;

const signalsArraySchemaRaw = z
  .array(z.union([learningSignalSchema, noteSignalSchema, decisionSignalSchema, taskPlanSignalSchema]))
  .refine(exactlyOneTaskPlan, 'exactly one task-plan signal per plan spawn');

/**
 * Cast bridge between Zod's inferred shape (optional fields widened to `T | undefined`
 * under `exactOptionalPropertyTypes`) and the strict-optional `PlanSignal` union the
 * leaf consumes downstream. The runtime check is the source of truth.
 */
const signalsArraySchema = signalsArraySchemaRaw as unknown as z.ZodType<readonly PlanSignal[]>;

/**
 * Legacy → v1 wrapping. Today's plan leaf synthesises a bare top-level array of signals from
 * the AI's `plan.json` body. Wave 6 swaps the prompt so the AI writes the
 * `{ schemaVersion, signals }` wrapper directly. Until then, this step shims the legacy shape
 * into the wrapper the validator expects.
 */
const wrapLegacyArray = (raw: unknown): unknown => {
  if (Array.isArray(raw)) return { schemaVersion: 1, signals: raw };
  return raw;
};

/** Static ISO timestamp embedded in the rendered example. Real spawns stamp `IsoTimestamp.now()`. */
const EXAMPLE_TS = '2026-05-22T10:00:00.000Z' as IsoTimestamp;

/**
 * Representative plan payload. The required `task-plan` carries the AI-authored task list as
 * a JSON string in `tasksJson` — opaque to the contract validator (parsed downstream by
 * `parsePlanOutput` against the task-import JSON Schema).
 */
const planExampleSignals: readonly PlanSignal[] = [
  {
    type: 'task-plan',
    tasksJson:
      '[{"name":"Wire export endpoint","ticketRef":"<ticket-uuid>","projectPath":"/abs/repo","steps":["..."],"verificationCriteria":["..."]}]',
    timestamp: EXAMPLE_TS,
  },
];

/**
 * Plan contract — audit-[09]. Composed only from `contract/_engine/` building blocks.
 *
 * @public
 */
export const planOutputContract: AiOutputContract<PlanSignal> = {
  schemaVersion: 1,
  signalsSchema: signalsArraySchema,
  sidecars: [],
  migrations: {
    0: wrapLegacyArray,
  },
  exampleSignals: planExampleSignals,
};

/**
 * Exported solely so the test grid can assert against the exact signal sub-union the
 * contract accepts. The leaf consumes the contract via `planOutputContract`; this alias
 * must not appear outside `__tests__/`.
 *
 * @public
 */
export type PlanContractSignal = PlanSignal;

const _signalCheck: PlanSignal extends AiSignal ? true : false = true;
void _signalCheck;
