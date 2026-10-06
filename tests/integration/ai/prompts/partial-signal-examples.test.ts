import { promises as fs } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Meta-test: the JSON example a `_partials/` body tells the AI to WRITE must itself validate
 * against the contract of the flow whose template includes that partial.
 *
 * No partial carries a copy-me block today (the output contract is the single source of signal
 * shapes). A partial that adds one must be mapped to its contract below.
 *
 * The directory is enumerated rather than listed, the way
 * `tests/integration/ai/prompts/template-coverage.test.ts` enumerates the prompt flows: a NEW
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

/** One partial's obligation: the flow whose template includes it, and that flow's contract erased to a verdict. */
interface PartialContract {
  /** Templates that include the partial — named in the test title. */
  readonly flow: string;
  /** Empty when the example validates; otherwise the contract's complaints. */
  readonly rejection: (signals: readonly unknown[]) => string;
}

/** Partial name (without `.md`) → the contract its json block is copied into. Empty while no partial ships one. */
const PARTIAL_CONTRACTS: Readonly<Record<string, PartialContract>> = {};

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

  it('the mapping is not vacuous (the known copy-me block is still found on disk)', async () => {
    expect(await partialsWithJsonBlock()).toEqual(expect.arrayContaining(Object.keys(PARTIAL_CONTRACTS)));
  });

  for (const [partial, { flow, rejection }] of Object.entries(PARTIAL_CONTRACTS)) {
    it(`${partial}.md parses as a ${flow} payload`, async () => {
      const issues = rejection(signalsOf(await firstJsonBlock(partial)));
      expect(issues, `_partials/${partial}.md rejected by the ${flow} contract: ${issues}`).toBe('');
    });
  }
});
