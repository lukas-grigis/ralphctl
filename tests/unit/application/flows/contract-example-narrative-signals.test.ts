import { describe, expect, it } from 'vitest';
import type { AiSignal } from '@src/domain/signal.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { AiOutputContract } from '@src/integration/ai/contract/_engine/types.ts';
import { planOutputContract } from '@src/application/flows/plan/leaves/plan.contract.ts';
import { ideateOutputContract } from '@src/application/flows/ideate/leaves/ideate.contract.ts';
import { refineOutputContract } from '@src/application/flows/refine/leaves/refine.contract.ts';
import { readinessOutputContract } from '@src/application/flows/readiness/leaves/readiness.contract.ts';
import { generatorOutputContract } from '@src/application/flows/implement/leaves/generator.contract.ts';
import { evaluatorOutputContract } from '@src/application/flows/implement/leaves/evaluator.contract.ts';
import { detectScriptsOutputContract } from '@src/application/flows/detect-scripts/leaves/propose.contract.ts';
import { detectSkillsOutputContract } from '@src/application/flows/detect-skills/leaves/propose.contract.ts';
import { generatePrContentOutputContract } from '@src/application/flows/create-pr/leaves/generate-pr-content.contract.ts';
import { reviewRoundOutputContract } from '@src/application/flows/review/leaves/review-round.contract.ts';

/**
 * The three narrative kinds every prompt invites as optional extras. They carry prose in
 * `text` — unlike the neighbouring `refined-ticket` / `pr-content` / `commit-message` signals,
 * which use `body`. A model that guesses `body` fails the whole-array parse and sinks the
 * round's real payload; for the interactive flows that is a user-approved session lost with no
 * retry path. The rendered `{{OUTPUT_CONTRACT_SECTION}}` is the only place the AI can read the
 * right shape, so a contract that ACCEPTS a narrative kind must also DEMONSTRATE it.
 */
const NARRATIVE_KINDS = ['learning', 'note', 'decision'] as const;

const isNarrative = (type: string): boolean => (NARRATIVE_KINDS as readonly string[]).includes(type);

const EXAMPLE_TS = '2026-05-22T10:00:00.000Z' as IsoTimestamp;

/**
 * Structural view of a contract, erased of its per-leaf signal sub-union. `AiOutputContract`
 * is invariant in `TSig` (the Zod schema appears in both positions), so a heterogeneous table
 * cannot hold the concrete contracts directly.
 */
interface ContractProbe {
  readonly signalsSchema: {
    readonly safeParse: (value: unknown) => { readonly success: boolean; readonly data?: unknown };
  };
  readonly exampleSignals: readonly AiSignal[];
}

const probe = <TSig extends AiSignal>(contract: AiOutputContract<TSig>): ContractProbe => contract;

const CONTRACTS: ReadonlyArray<readonly [string, ContractProbe]> = [
  ['plan', probe(planOutputContract)],
  ['ideate', probe(ideateOutputContract)],
  ['refine', probe(refineOutputContract)],
  ['readiness', probe(readinessOutputContract)],
  ['implement/generator', probe(generatorOutputContract)],
  ['implement/evaluator', probe(evaluatorOutputContract)],
  ['detect-scripts', probe(detectScriptsOutputContract)],
  ['detect-skills', probe(detectSkillsOutputContract)],
  ['create-pr', probe(generatePrContentOutputContract)],
  ['review', probe(reviewRoundOutputContract)],
];

/**
 * Does the contract carry `kind` through to its validated output? Probed rather than
 * introspected: the schemas carry `refine`d cardinality rules (exactly one `task-plan`, exactly
 * one `ideated-tickets`, …), so the probe keeps the contract's own non-narrative example signals
 * as the required payload and swaps in a single narrative candidate.
 *
 * "Carries through" — not merely "parses". The create-pr contract is deliberately tolerant: it
 * DROPS stray narrative signals before validation rather than failing on them, so a probe that
 * only checked `success` would demand examples for kinds that contract discards.
 */
const accepts = (contract: ContractProbe, kind: string): boolean => {
  const payload = contract.exampleSignals.filter((s) => !isNarrative(s.type));
  const result = contract.signalsSchema.safeParse([...payload, { type: kind, text: 'probe', timestamp: EXAMPLE_TS }]);
  if (!result.success || !Array.isArray(result.data)) return false;
  return result.data.some((s: unknown) => (s as { readonly type?: unknown }).type === kind);
};

describe('AI output contracts — narrative signal examples', () => {
  it.each(CONTRACTS)('%s demonstrates every narrative kind it accepts', (_name, contract) => {
    const shown = new Set(contract.exampleSignals.map((s) => s.type));
    const missing = NARRATIVE_KINDS.filter((kind) => accepts(contract, kind) && !shown.has(kind));
    expect(missing).toEqual([]);
  });

  it.each(CONTRACTS)('%s example signals round-trip through its own schema', (_name, contract) => {
    expect(contract.signalsSchema.safeParse(contract.exampleSignals).success).toBe(true);
  });

  it.each(CONTRACTS)('%s never shows a narrative signal carrying `body`', (_name, contract) => {
    const offenders = contract.exampleSignals
      .filter((s) => isNarrative(s.type))
      .filter((s) => 'body' in s)
      .map((s) => s.type);
    expect(offenders).toEqual([]);
  });
});
