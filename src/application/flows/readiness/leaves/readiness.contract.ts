import { z } from 'zod';
import type {
  AgentsMdProposalSignal,
  AiSignal,
  LearningSignal,
  NoteSignal,
  SetupSkillProposalSignal,
  SkillSuggestionsSignal,
  VerifySkillProposalSignal,
} from '@src/domain/signal.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { agentsMdProposalSignalSchema } from '@src/integration/ai/contract/_engine/signals/agents-md-proposal/schema.ts';
import { learningSignalSchema } from '@src/integration/ai/contract/_engine/signals/learning/schema.ts';
import { noteSignalSchema } from '@src/integration/ai/contract/_engine/signals/note/schema.ts';
import { setupSkillProposalSignalSchema } from '@src/integration/ai/contract/_engine/signals/setup-skill-proposal/schema.ts';
import { skillSuggestionsSignalSchema } from '@src/integration/ai/contract/_engine/signals/skill-suggestions/schema.ts';
import { verifySkillProposalSignalSchema } from '@src/integration/ai/contract/_engine/signals/verify-skill-proposal/schema.ts';
import type { AiOutputContract, SidecarRule } from '@src/integration/ai/contract/_engine/types.ts';

/**
 * Per-leaf I/O contract for the readiness one-shot AI session — audit-[09]. The session may emit:
 *
 *   - narrative fan-out: `learning`, `note`
 *   - one optional `agents-md-proposal` carrying the tool-native context-file body (`CLAUDE.md`,
 *     `.github/copilot-instructions.md`, or `AGENTS.md`)
 *   - one optional `setup-skill-proposal` carrying a project-tracked setup skill body
 *   - one optional `verify-skill-proposal` carrying a project-tracked verify skill body
 *   - one optional `skill-suggestions` recommending bundled skills by kebab-case name
 *
 * Unlike refine / evaluator, the schema imposes NO `exactlyOne` constraint — each sidecar signal
 * is independent and optional. The AI may legitimately propose just the context file, just one of
 * the skill bodies, all three together, or none (probe-only round). The harness renders sidecar
 * files only for the kinds actually present.
 *
 * Sidecar layout (each optional, written only if its signal is present):
 *
 *   `agents-md-proposal.md` — operator-readable context-file body. Downstream consumer
 *     (the readiness write leaf) reads `agents-md-proposal.content` from ctx, not from this
 *     file; the file exists for operator review.
 *   `setup-skill.md`        — operator-readable setup skill body. The post-readiness skills-
 *     install step copies it into `<repo>/<parentDir>/skills/setup/SKILL.md` after approval.
 *   `verify-skill.md`       — same pattern as `setup-skill.md`, but for verify.
 *
 * Migration chain:
 *
 *   `migrations[0]` accepts the legacy top-level-array shape the existing readiness signals
 *   pipeline produces today (the headless adapter parses XML tags into a `HarnessSignal[]`
 *   and the leaf re-writes that array as `signals.json`). Wave 6 swaps the prompt so the AI
 *   writes the canonical `{ schemaVersion, signals }` wrapper directly; the migration becomes
 *   inert at that point but stays in the chain for in-flight forensic artifacts.
 */

type ReadinessSignal =
  | LearningSignal
  | NoteSignal
  | AgentsMdProposalSignal
  | SetupSkillProposalSignal
  | VerifySkillProposalSignal
  | SkillSuggestionsSignal;

const signalsArraySchemaRaw = z.array(
  z.union([
    learningSignalSchema,
    noteSignalSchema,
    agentsMdProposalSignalSchema,
    setupSkillProposalSignalSchema,
    verifySkillProposalSignalSchema,
    skillSuggestionsSignalSchema,
  ])
);

/**
 * Cast bridge between Zod's inferred shape (optional fields widened to `T | undefined`
 * under `exactOptionalPropertyTypes`) and the strict-optional `ReadinessSignal` union the
 * leaf consumes downstream. The runtime check is the source of truth; the cast just
 * narrows the static type so the contract's generic argument flows precisely through
 * `validateSignalsFile` and `renderSidecars`.
 */
const signalsArraySchema = signalsArraySchemaRaw as unknown as z.ZodType<readonly ReadinessSignal[]>;

/**
 * Legacy → v1 wrapping. The readiness leaf synthesises a bare top-level array of contract-
 * accepted signals from the existing headless-adapter `HarnessSignal[]` pipeline. Wave 6
 * swaps the prompt so the AI writes the `{ schemaVersion, signals }` wrapper directly. Until
 * then, this step shims the legacy shape into the wrapper the validator expects.
 */
const wrapLegacyArray = (raw: unknown): unknown => {
  if (Array.isArray(raw)) return { schemaVersion: 1, signals: raw };
  // Already-wrapped payloads (writer migrated, fixture, …) pass through. Anything else
  // also passes through; Zod will catch shape errors with a precise issue path.
  return raw;
};

/**
 * Sidecar rules. Each `multiplicity: 'optional'` — the helper renders only when the matching
 * signal is present. `extract` projects the signal's `content` field verbatim onto the file
 * body so the prompt-side example and the leaf-side write share one source of truth.
 *
 * Declaring each rule via the per-kind `SidecarRule<K>` lets `extract` narrow to the matching
 * variant of `AiSignal` at authoring time. Storing the rules in the contract's `sidecars`
 * array requires a cast because `extract`'s parameter is contravariant — `SidecarRule<'X'>`
 * is authored-narrow but not assignable to `SidecarRule<ReadinessSignal['type']>`. At runtime
 * `renderSidecars` filters by `signalKind` before calling `extract`, so the narrowing the
 * cast erases is preserved by the helper.
 */
const agentsMdSidecar: SidecarRule<'agents-md-proposal'> = {
  signalKind: 'agents-md-proposal',
  filename: 'agents-md-proposal.md',
  multiplicity: 'optional',
  extract: (signal) => signal.content,
};

const setupSkillSidecar: SidecarRule<'setup-skill-proposal'> = {
  signalKind: 'setup-skill-proposal',
  filename: 'setup-skill.md',
  multiplicity: 'optional',
  extract: (signal) => signal.content,
};

const verifySkillSidecar: SidecarRule<'verify-skill-proposal'> = {
  signalKind: 'verify-skill-proposal',
  filename: 'verify-skill.md',
  multiplicity: 'optional',
  extract: (signal) => signal.content,
};

/** Static ISO timestamp embedded in the rendered example. Real spawns stamp `IsoTimestamp.now()`. */
const EXAMPLE_TS = '2026-05-22T10:00:00.000Z' as IsoTimestamp;

/**
 * Representative readiness payload. Shows the AI all three sidecar-bearing kinds so it knows
 * the proposal envelope is one signal per artefact, not one signal carrying every body. The
 * Wave-6 prompt swaps the historical XML-tag emission for direct signals.json writes.
 */
const readinessExampleSignals: readonly ReadinessSignal[] = [
  {
    type: 'agents-md-proposal',
    tag: 'claude-md',
    content: '# Project Context\n\n## Build & Run\n\n`pnpm dev` — runs the dev server.',
    timestamp: EXAMPLE_TS,
  },
  {
    type: 'setup-skill-proposal',
    content: '# Setup\n\nRun `pnpm install` to install dependencies.',
    timestamp: EXAMPLE_TS,
  },
  {
    type: 'verify-skill-proposal',
    content: '# Verify\n\nRun `pnpm verify` (typecheck + lint + test).',
    timestamp: EXAMPLE_TS,
  },
  { type: 'skill-suggestions', names: ['typescript-strict', 'pnpm'], timestamp: EXAMPLE_TS },
];

/**
 * Readiness contract — audit-[09]. Composed only from `contract/_engine/` building blocks.
 *
 * @public
 */
export const readinessOutputContract: AiOutputContract<ReadinessSignal> = {
  schemaVersion: 1,
  signalsSchema: signalsArraySchema,
  sidecars: [
    agentsMdSidecar as SidecarRule<ReadinessSignal['type']>,
    setupSkillSidecar as SidecarRule<ReadinessSignal['type']>,
    verifySkillSidecar as SidecarRule<ReadinessSignal['type']>,
  ],
  migrations: {
    0: wrapLegacyArray,
  },
  exampleSignals: readinessExampleSignals,
};

/**
 * Exported solely so the test grid can assert against the exact signal sub-union the
 * contract accepts. The leaf consumes the contract via `readinessOutputContract`; this
 * alias must not appear outside `__tests__/`.
 *
 * @public
 */
export type ReadinessContractSignal = ReadinessSignal;

const _signalCheck: ReadinessSignal extends AiSignal ? true : false = true;
void _signalCheck;
