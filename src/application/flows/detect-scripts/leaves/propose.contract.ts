import { z } from 'zod';
import type { AiSignal, NoteSignal, SetupScriptSignal, VerifyScriptSignal } from '@src/domain/signal.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { noteSignalSchema } from '@src/integration/ai/contract/_engine/signals/note/schema.ts';
import { setupScriptSignalSchema } from '@src/integration/ai/contract/_engine/signals/setup-script/schema.ts';
import { verifyScriptSignalSchema } from '@src/integration/ai/contract/_engine/signals/verify-script/schema.ts';
import { brandSignalArray } from '@src/integration/ai/contract/_engine/brand-signal-array.ts';
import type { AiOutputContract } from '@src/integration/ai/contract/_engine/types.ts';

/**
 * Per-leaf I/O contract for the detect-scripts one-shot session — audit-[09]. The session may
 * emit at most one of each:
 *
 *   - `setup-script` — single shell line for the sprint-start setup gate (optional).
 *   - `verify-script` — single shell line for the post-task verify gate (optional).
 *   - `note` — operator-readable observation (optional, free-form).
 *
 * Both `setup-script` and `verify-script` are optional. A clean repo where the AI honestly
 * says "nothing to do" emits neither; the confirm leaf shows a "no suggestions" state in
 * that case. Failing the chain on missing signals would be the wrong outcome for a useful
 * "no answer".
 *
 * No sidecars — the rendered prompt + raw body live in the per-run forensic dir already;
 * adding a derived sidecar over the validated signals would just duplicate the script lines.
 *
 * Migration chain: `migrations[0]` accepts the legacy bare-array shape pre-contract files
 * carried; new files declare `schemaVersion: 1`.
 */

type DetectScriptsSignal = SetupScriptSignal | VerifyScriptSignal | NoteSignal;

const atMostOneOf =
  (kind: string) =>
  (signals: ReadonlyArray<{ readonly type: string }>): boolean =>
    signals.filter((s) => s.type === kind).length <= 1;

const signalsArraySchemaRaw = z
  .array(z.union([setupScriptSignalSchema, verifyScriptSignalSchema, noteSignalSchema]))
  .refine(atMostOneOf('setup-script'), 'at most one setup-script signal per detect-scripts spawn')
  .refine(atMostOneOf('verify-script'), 'at most one verify-script signal per detect-scripts spawn');

/**
 * Cast bridge between Zod's inferred shape (optional fields widened to `T | undefined`
 * under `exactOptionalPropertyTypes`) and the strict-optional `DetectScriptsSignal` union the
 * leaf consumes downstream. The runtime check is the source of truth; the cast just narrows
 * the static type so the contract's generic argument flows precisely through
 * `validateSignalsFile`.
 */
const signalsArraySchema = brandSignalArray<DetectScriptsSignal>(signalsArraySchemaRaw);

/**
 * Legacy → v1 wrapping. Pre-contract sessions wrote bare arrays via the headless adapter's
 * stdout parser; today's prompts instruct the AI to write the wrapper directly.
 */
const wrapLegacyArray = (raw: unknown): unknown => {
  if (Array.isArray(raw)) return { schemaVersion: 1, signals: raw };
  return raw;
};

/** Static ISO timestamp embedded in the rendered example. Real spawns stamp `IsoTimestamp.now()`. */
const EXAMPLE_TS = '2026-05-22T10:00:00.000Z' as IsoTimestamp;

const EXAMPLE_SIGNALS: readonly DetectScriptsSignal[] = [
  { type: 'setup-script', command: 'pnpm install', timestamp: EXAMPLE_TS },
  {
    type: 'verify-script',
    command: 'pnpm typecheck && pnpm lint && pnpm test',
    timestamp: EXAMPLE_TS,
  },
  {
    type: 'note',
    text: 'Commands lifted verbatim from CLAUDE.md.',
    timestamp: EXAMPLE_TS,
  },
];

export const detectScriptsOutputContract: AiOutputContract<DetectScriptsSignal> = {
  schemaVersion: 1,
  signalsSchema: signalsArraySchema,
  sidecars: [],
  migrations: { 0: wrapLegacyArray },
  exampleSignals: EXAMPLE_SIGNALS,
};

/** @public */
export type DetectScriptsContractSignal = Extract<AiSignal, DetectScriptsSignal>;
