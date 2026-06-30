import { z } from 'zod';
import type { AiSignal, NoteSignal, SetupSkillProposalSignal, VerifySkillProposalSignal } from '@src/domain/signal.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { noteSignalSchema } from '@src/integration/ai/contract/_engine/signals/note/schema.ts';
import { setupSkillProposalSignalSchema } from '@src/integration/ai/contract/_engine/signals/setup-skill-proposal/schema.ts';
import { verifySkillProposalSignalSchema } from '@src/integration/ai/contract/_engine/signals/verify-skill-proposal/schema.ts';
import { brandSignalArray } from '@src/integration/ai/contract/_engine/brand-signal-array.ts';
import type { AiOutputContract, SidecarRule } from '@src/integration/ai/contract/_engine/types.ts';

/**
 * Per-leaf I/O contract for the detect-skills one-shot session — audit-[09]. The session may
 * emit at most one of each:
 *
 *   - `setup-skill-proposal` — multi-paragraph markdown body for the sprint-setup skill (optional).
 *   - `verify-skill-proposal` — multi-paragraph markdown body for the post-task verify skill (optional).
 *   - `note` — operator-readable observation (optional, free-form).
 *
 * Both proposals are optional. A repo where existing skills already cover both responsibilities
 * emits neither; the confirm leaf shows a "no suggestions" state. Failing the chain on missing
 * signals would be the wrong outcome — silence here is a valid answer.
 *
 * Sidecars: the two proposal bodies render as `setup-skill.md` and `verify-skill.md` (operator
 * review pre-install) so the confirm leaf can show the user the markdown before the writer leaf
 * lands it under `<repo>/<parentDir>/skills/{setup,verify}/SKILL.md`.
 *
 * Migration chain: `migrations[0]` accepts the legacy bare-array shape pre-contract files
 * carried; new files declare `schemaVersion: 1`.
 */

type DetectSkillsSignal = SetupSkillProposalSignal | VerifySkillProposalSignal | NoteSignal;

const SETUP_SKILL_PROPOSAL = 'setup-skill-proposal';
const VERIFY_SKILL_PROPOSAL = 'verify-skill-proposal';

const atMostOneOf =
  (kind: string) =>
  (signals: ReadonlyArray<{ readonly type: string }>): boolean =>
    signals.filter((s) => s.type === kind).length <= 1;

const signalsArraySchemaRaw = z
  .array(z.union([setupSkillProposalSignalSchema, verifySkillProposalSignalSchema, noteSignalSchema]))
  .refine(atMostOneOf(SETUP_SKILL_PROPOSAL), 'at most one setup-skill-proposal per detect-skills spawn')
  .refine(atMostOneOf(VERIFY_SKILL_PROPOSAL), 'at most one verify-skill-proposal per detect-skills spawn');

/**
 * Cast bridge between Zod's inferred shape (optional fields widened to `T | undefined`
 * under `exactOptionalPropertyTypes`) and the strict-optional `DetectSkillsSignal` union the
 * leaf consumes downstream. The runtime check is the source of truth; the cast just narrows
 * the static type so the contract's generic argument flows precisely through
 * `validateSignalsFile`.
 */
const signalsArraySchema = brandSignalArray<DetectSkillsSignal>(signalsArraySchemaRaw);

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

const EXAMPLE_SIGNALS: readonly DetectSkillsSignal[] = [
  {
    type: SETUP_SKILL_PROPOSAL,
    content:
      'This repo pins tool versions with mise. Before editing anything, run mise install to activate the exact versions declared in mise.toml. Then run the project install command documented in CLAUDE.md to hydrate the dependency tree.',
    timestamp: EXAMPLE_TS,
  },
  {
    type: VERIFY_SKILL_PROPOSAL,
    content:
      'Verification runs three gates in sequence documented in CLAUDE.md: typecheck, lint, then tests. A failure in any gate stops the chain; read the first failing gate output — later gates have not run yet.',
    timestamp: EXAMPLE_TS,
  },
  {
    type: 'note',
    text: 'Skills authored from CLAUDE.md and mise.toml.',
    timestamp: EXAMPLE_TS,
  },
];

const setupSkillSidecar: SidecarRule<'setup-skill-proposal'> = {
  signalKind: SETUP_SKILL_PROPOSAL,
  filename: 'setup-skill.md',
  multiplicity: 'optional',
  extract: (signal) => signal.content,
};

const verifySkillSidecar: SidecarRule<'verify-skill-proposal'> = {
  signalKind: VERIFY_SKILL_PROPOSAL,
  filename: 'verify-skill.md',
  multiplicity: 'optional',
  extract: (signal) => signal.content,
};

export const detectSkillsOutputContract: AiOutputContract<DetectSkillsSignal> = {
  schemaVersion: 1,
  signalsSchema: signalsArraySchema,
  sidecars: [setupSkillSidecar, verifySkillSidecar] as ReadonlyArray<SidecarRule<DetectSkillsSignal['type']>>,
  migrations: { 0: wrapLegacyArray },
  exampleSignals: EXAMPLE_SIGNALS,
};

/** @public */
export type DetectSkillsContractSignal = Extract<AiSignal, DetectSkillsSignal>;
