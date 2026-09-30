import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadFixtures } from '../../../../scripts/eval/load-fixtures.ts';
import { makeTmpRoot } from '../../../fixtures/tmp-root.ts';
import { writeMiniFixtures } from '../../../fixtures/eval-harness.ts';

let root: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  const tmp = await makeTmpRoot();
  root = String(tmp.root);
  cleanup = tmp.cleanup;
});
afterEach(async () => {
  await cleanup();
});

const load = async (filter = {}) => {
  const loaded = await loadFixtures(root, filter);
  if (!loaded.ok) throw new Error(loaded.error.message);
  return loaded.value;
};
const loadError = async (): Promise<string> => {
  const loaded = await loadFixtures(root);
  if (loaded.ok) throw new Error('expected a load error');
  return loaded.error.message;
};

describe('loadFixtures', () => {
  it('loads every flow, sorted by flow then id, with the fixture directory attached', async () => {
    await writeMiniFixtures(root);
    const { fixtures } = await load();
    expect(fixtures.map((f) => f.id)).toEqual(['mini-ev', 'mini-im', 'mini-ds', 'mini-sc']);
    expect(fixtures[0]?.dir).toBe(join(root, 'evaluate', 'mini-ev'));
  });

  it('returns an empty set for a fixtures root with nothing in it', async () => {
    expect((await load()).fixtures).toEqual([]);
  });

  it('filters by flow, tier and id glob', async () => {
    await writeMiniFixtures(root);
    expect((await load({ flows: ['implement', 'detect-scripts'] })).fixtures.map((f) => f.id)).toEqual([
      'mini-im',
      'mini-ds',
    ]);
    expect((await load({ tier: 'capability' })).fixtures).toEqual([]);
    expect((await load({ idGlob: 'mini-e*,mini-s*' })).fixtures.map((f) => f.id)).toEqual(['mini-ev', 'mini-sc']);
  });

  it('rejects duplicate fixture ids, even across flows', async () => {
    await writeMiniFixtures(root, ['evaluate', 'implement']);
    for (const [flow, old] of [
      ['evaluate', 'mini-ev'],
      ['implement', 'mini-im'],
    ] as const) {
      await fs.rename(join(root, flow, old), join(root, flow, 'dup'));
      const specPath = join(root, flow, 'dup', 'fixture.json');
      const spec = JSON.parse(await fs.readFile(specPath, 'utf8')) as Record<string, unknown>;
      await fs.writeFile(specPath, JSON.stringify({ ...spec, id: 'dup' }));
    }
    expect(await loadError()).toContain("duplicate fixture id 'dup'");
  });

  it('rejects a fixture whose id does not match its directory', async () => {
    await writeMiniFixtures(root, ['evaluate']);
    await fs.rename(join(root, 'evaluate', 'mini-ev'), join(root, 'evaluate', 'other'));
    expect(await loadError()).toContain("does not match its directory 'other'");
  });

  it('rejects a fixture filed under the wrong flow directory', async () => {
    await writeMiniFixtures(root, ['evaluate']);
    await fs.mkdir(join(root, 'implement'), { recursive: true });
    await fs.rename(join(root, 'evaluate', 'mini-ev'), join(root, 'implement', 'mini-ev'));
    expect(await loadError()).toContain("does not match its directory 'implement'");
  });

  it.each([
    ['a variant patch', join('evaluate', 'mini-ev', 'variants', 'defect.patch')],
    ['the repo tree', join('evaluate', 'mini-ev', 'repo')],
    ['the oracle directory', join('evaluate', 'mini-ev', 'oracle')],
  ])('rejects a fixture with %s missing', async (_name, rel) => {
    await writeMiniFixtures(root, ['evaluate']);
    await fs.rm(join(root, rel), { recursive: true });
    expect(await loadError()).toContain('referenced path is missing');
  });

  it('rejects a missing select-candidate summary', async () => {
    await writeMiniFixtures(root, ['select-candidate']);
    await fs.rm(join(root, 'select-candidate', 'mini-sc', 'candidates', 'b.json'));
    expect(await loadError()).toContain('b.json');
  });

  it('rejects invalid JSON and schema violations with the offending path', async () => {
    await writeMiniFixtures(root, ['evaluate']);
    const specPath = join(root, 'evaluate', 'mini-ev', 'fixture.json');
    await fs.writeFile(specPath, '{ nope');
    expect(await loadError()).toContain('fixture.json');
    await fs.writeFile(specPath, JSON.stringify({ schemaVersion: 1, flow: 'evaluate', id: 'mini-ev' }));
    expect(await loadError()).toMatch(/tier|cluster|task/);
  });

  it('a filtered-out fixture is still validated', async () => {
    await writeMiniFixtures(root);
    await fs.rm(join(root, 'implement', 'mini-im', 'oracle'), { recursive: true });
    const loaded = await loadFixtures(root, { flows: ['evaluate'] });
    expect(loaded.ok).toBe(false);
  });

  it('hashes the fixture set: stable when untouched, different when any file changes', async () => {
    await writeMiniFixtures(root, ['evaluate']);
    const first = (await load()).fixtureSetHash;
    expect((await load()).fixtureSetHash).toBe(first);
    await fs.appendFile(join(root, 'evaluate', 'mini-ev', 'oracle', 'inc.test.mjs'), '// touched\n');
    expect((await load()).fixtureSetHash).not.toBe(first);
  });
});
