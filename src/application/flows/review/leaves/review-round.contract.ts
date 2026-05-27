import { z } from 'zod';
import type { AiSignal, TaskBlockedSignal, TaskCompleteSignal } from '@src/domain/signal.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { taskBlockedSignalSchema } from '@src/integration/ai/contract/_engine/signals/task-blocked/schema.ts';
import { taskCompleteSignalSchema } from '@src/integration/ai/contract/_engine/signals/task-complete/schema.ts';
import { brandSignalArray } from '@src/integration/ai/contract/_engine/brand-signal-array.ts';
import type { AiOutputContract } from '@src/integration/ai/contract/_engine/types.ts';

/**
 * Per-leaf I/O contract for one round of the review (apply-feedback) chain — audit-[09].
 * The AI session may emit at most one of two terminal signals:
 *
 *   - `task-complete`        — round applied successfully; harness commits + verifies.
 *   - `task-blocked` (reason) — round could not be applied; harness ends the review loop.
 *
 * Implementation contract: exactly one of the two MUST be present per spawn. The Zod refine
 * enforces this at validation time so the leaf-side decision tree (`runReviewRoundUseCase`)
 * sees an unambiguous outcome — no "AI emitted both" or "AI emitted neither" silent paths.
 *
 * No sidecars — the operator UX for review is `feedback.md` (round bodies live there) and
 * the live TUI banner; nothing on-disk is derived from these terminal signals.
 *
 * Migration chain: `migrations[0]` accepts the legacy bare-array shape `signals.json` files
 * carried before the prompt-side contract flip; new files declare `schemaVersion: 1`. The
 * step is inert for the freshly-rendered contract section but stays in the chain for
 * forensic re-replay of in-flight rounds written before this migration landed.
 */

type ReviewRoundSignal = TaskCompleteSignal | TaskBlockedSignal;

const hasExactlyOneTerminal = (signals: ReadonlyArray<{ readonly type: string }>): boolean => {
  const terminals = signals.filter((s) => s.type === 'task-complete' || s.type === 'task-blocked');
  return terminals.length === 1;
};

const signalsArraySchemaRaw = z
  .array(z.union([taskCompleteSignalSchema, taskBlockedSignalSchema]))
  .refine(hasExactlyOneTerminal, 'exactly one of `task-complete` or `task-blocked` is required per round');

/**
 * Cast bridge between Zod's inferred shape (optional fields widened to `T | undefined`
 * under `exactOptionalPropertyTypes`) and the strict-optional `ReviewRoundSignal` union the
 * leaf consumes downstream. The runtime check is the source of truth; the cast just narrows
 * the static type so the contract's generic argument flows precisely through
 * `validateSignalsFile`.
 */
const signalsArraySchema = brandSignalArray<ReviewRoundSignal>(signalsArraySchemaRaw);

/**
 * Legacy → v1 wrapping. Older sprint review rounds (pre-contract) produced bare arrays via
 * the headless adapter's stdout parser. Today's prompts instruct the AI to write the wrapper
 * directly via its `Write` tool. The step is a passthrough for already-wrapped payloads.
 */
const wrapLegacyArray = (raw: unknown): unknown => {
  if (Array.isArray(raw)) return { schemaVersion: 1, signals: raw };
  return raw;
};

/** Static ISO timestamp embedded in the rendered example. Real spawns stamp `IsoTimestamp.now()`. */
const EXAMPLE_TS = '2026-05-22T10:00:00.000Z' as IsoTimestamp;

/**
 * Worked example embedded in the prompt's `{{OUTPUT_CONTRACT_SECTION}}` so the AI sees the
 * canonical wrapper shape. The unit-test meta-grid round-trips this through `signalsSchema`
 * to catch schema drift.
 */
const EXAMPLE_SIGNALS: readonly ReviewRoundSignal[] = [{ type: 'task-complete', timestamp: EXAMPLE_TS }];

export const reviewRoundOutputContract: AiOutputContract<ReviewRoundSignal> = {
  schemaVersion: 1,
  signalsSchema: signalsArraySchema,
  sidecars: [],
  migrations: { 0: wrapLegacyArray },
  exampleSignals: EXAMPLE_SIGNALS,
};

// Type-narrowing helper for the contract's signal sub-union. Exported so tests can build
// fixtures without re-deriving the union locally.
/** @public */
export type ReviewRoundContractSignal = Extract<AiSignal, ReviewRoundSignal>;
