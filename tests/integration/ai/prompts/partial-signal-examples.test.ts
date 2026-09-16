import { promises as fs } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AiSignal } from '@src/domain/signal.ts';
import type { AiOutputContract } from '@src/integration/ai/contract/_engine/types.ts';
import { evaluatorOutputContract } from '@src/application/flows/implement/leaves/evaluator.contract.ts';
import { generatorOutputContract } from '@src/application/flows/implement/leaves/generator.contract.ts';

/**
 * Meta-test: the JSON example a `_partials/` body tells the AI to WRITE must itself validate
 * against the contract of the flow whose template includes that partial.
 *
 * Both of today's blocks are copy-me examples, not shape sketches. `evaluation-checkpoint.md` is
 * the payload the evaluator is told to write "first, before any verification", so that a session
 * which exhausts its budget mid-analysis leaves a valid `signals.json` behind; a placeholder
 * value copied verbatim produces an invalid file in exactly the scenario the checkpoint was
 * added for. `decisions.md` shows the one-line `decision` signal the generator appends.
 *
 * `IsoTimestampSchema` is a branded parse and `defaultMissingTimestamps` only fills a MISSING or
 * empty field, so a non-empty `"<ISO-8601 timestamp>"` reaches the schema unchanged and fails it
 * — which is why both partials carry a concrete ISO-8601 value, matching the worked examples
 * further down their own templates.
 *
 * The directory is enumerated rather than listed, the way
 * `tests/integration/ai/prompts/template-coverage.test.ts` enumerates the prompt flows: a THIRD
 * partial carrying a copy-me json block must join this gate instead of shipping unchecked, so it
 * fails the mapping assertion below until someone names the contract it has to satisfy.
 */

const PARTIALS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'src',
  'integration',
  'ai',
  'prompts',
  '_partials'
);

/** Detects a fenced json block; the extraction regex below is global and must stay local. */
const HAS_JSON_BLOCK = /```json\n/u;

/**
 * One partial's obligation: the flow whose template includes it, and that flow's contract erased
 * to a verdict. `AiOutputContract` is invariant in `TSig`, so a heterogeneous table cannot hold
 * the concrete contracts — same bridge as `flow-signal-compatibility.test.ts`'s `ContractProbe`.
 */
interface PartialContract {
  /** Templates that include the partial — named in the test title. */
  readonly flow: string;
  /** Empty when the example validates; otherwise the contract's complaints. */
  readonly rejection: (signals: readonly unknown[]) => string;
}

const against = <TSig extends AiSignal>(flow: string, contract: AiOutputContract<TSig>): PartialContract => ({
  flow,
  rejection: (signals) => {
    const result = contract.signalsSchema.safeParse(signals);
    return result.success ? '' : JSON.stringify(result.error.issues);
  },
});

/** Partial name (without `.md`) → the contract its json block is copied into. */
const PARTIAL_CONTRACTS: Readonly<Record<string, PartialContract>> = {
  'evaluation-checkpoint': against('evaluate / evaluate-continuation', evaluatorOutputContract),
  decisions: against('implement / implement-continuation', generatorOutputContract),
};

/** First fenced ```json block in a partial body, parsed. */
const firstJsonBlock = async (partial: string): Promise<unknown> => {
  const body = await fs.readFile(join(PARTIALS_DIR, `${partial}.md`), 'utf8');
  const match = /```json\n([\s\S]*?)```/u.exec(body);
  if (match?.[1] === undefined) throw new Error(`no fenced json block in _partials/${partial}.md`);
  return JSON.parse(match[1]);
};

const signalsOf = (parsed: unknown): readonly unknown[] => {
  if (Array.isArray(parsed)) return parsed;
  const wrapper = parsed as { readonly signals?: unknown };
  return Array.isArray(wrapper.signals) ? wrapper.signals : [parsed];
};

/** Every `_partials/*.md` whose body carries a json block the AI could copy verbatim. */
const partialsWithJsonBlock = async (): Promise<readonly string[]> => {
  const files = (await fs.readdir(PARTIALS_DIR)).filter((name) => name.endsWith('.md')).sort();
  const carrying: string[] = [];
  for (const file of files) {
    const body = await fs.readFile(join(PARTIALS_DIR, file), 'utf8');
    if (HAS_JSON_BLOCK.test(body)) carrying.push(basename(file, '.md'));
  }
  return carrying;
};

describe('partial JSON examples validate against the contract of the flow that includes them', () => {
  it('every partial carrying a json block is mapped to a contract', async () => {
    const unmapped = (await partialsWithJsonBlock()).filter((partial) => PARTIAL_CONTRACTS[partial] === undefined);
    expect(
      unmapped,
      unmapped.map((partial) => `add a contract mapping for _partials/${partial}.md`).join('; ')
    ).toEqual([]);
  });

  it('the mapping is not vacuous (both known copy-me blocks are still found on disk)', async () => {
    expect(await partialsWithJsonBlock()).toEqual(expect.arrayContaining(Object.keys(PARTIAL_CONTRACTS)));
  });

  for (const [partial, { flow, rejection }] of Object.entries(PARTIAL_CONTRACTS)) {
    it(`${partial}.md parses as a ${flow} payload`, async () => {
      const issues = rejection(signalsOf(await firstJsonBlock(partial)));
      expect(issues, `_partials/${partial}.md rejected by the ${flow} contract: ${issues}`).toBe('');
    });
  }
});
