import { z } from 'zod';
import type {
  AiSignal,
  NoteSignal,
  SetupScriptSignal,
  VerifyGatesSignal,
  VerifyScriptSignal,
} from '@src/domain/signal.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { noteSignalSchema } from '@src/integration/ai/contract/_engine/signals/note/schema.ts';
import { setupScriptSignalSchema } from '@src/integration/ai/contract/_engine/signals/setup-script/schema.ts';
import { verifyScriptSignalSchema } from '@src/integration/ai/contract/_engine/signals/verify-script/schema.ts';
import { verifyGatesSignalSchema } from '@src/integration/ai/contract/_engine/signals/verify-gates/schema.ts';
import { brandSignalArray } from '@src/integration/ai/contract/_engine/brand-signal-array.ts';
import type { AiOutputContract } from '@src/integration/ai/contract/_engine/types.ts';

/**
 * Per-leaf I/O contract for the detect-scripts one-shot session — audit-[09]. The session may
 * emit at most one of each:
 *
 *   - `setup-script` — single shell line for the sprint-start setup gate (optional).
 *   - `verify-script` — single shell line for the post-task verify gate (optional).
 *   - `verify-gates` — structured per-module gates for monorepo-style repos (optional, ADDITIVE
 *     to `verify-script`: emitted only alongside the single-line fallback, never instead of it).
 *   - `note` — operator-readable observation (optional, free-form).
 *
 * Every signal kind is optional. A clean single-module repo emits `setup-script` + `verify-script`
 * and no gates; a monorepo emits all three; a repo the AI cannot characterise emits a bare `note`.
 * Failing the chain on missing signals would be the wrong outcome for a useful "no answer".
 *
 * No sidecars — the rendered prompt + raw body live in the per-run forensic dir already;
 * adding a derived sidecar over the validated signals would just duplicate the script lines.
 *
 * Migration chain: `migrations[0]` accepts the legacy bare-array shape pre-contract files
 * carried; new files declare `schemaVersion: 1`.
 */

type DetectScriptsSignal = SetupScriptSignal | VerifyScriptSignal | VerifyGatesSignal | NoteSignal;

const atMostOneOf =
  (kind: string) =>
  (signals: ReadonlyArray<{ readonly type: string }>): boolean =>
    signals.filter((s) => s.type === kind).length <= 1;

const signalsArraySchemaRaw = z
  .array(z.union([setupScriptSignalSchema, verifyScriptSignalSchema, verifyGatesSignalSchema, noteSignalSchema]))
  .refine(atMostOneOf('setup-script'), 'at most one setup-script signal per detect-scripts spawn')
  .refine(atMostOneOf('verify-script'), 'at most one verify-script signal per detect-scripts spawn')
  .refine(atMostOneOf('verify-gates'), 'at most one verify-gates signal per detect-scripts spawn');

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
    type: 'verify-gates',
    gates: [
      { pathPrefix: 'services/api/', command: 'pnpm --filter api test' },
      { pathPrefix: 'services/web/', command: 'pnpm --filter web test' },
    ],
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
