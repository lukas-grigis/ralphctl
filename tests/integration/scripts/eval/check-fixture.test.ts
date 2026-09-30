import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGitRunner } from '@src/integration/io/git-runner.ts';
import { createShellScriptRunner } from '@src/integration/io/shell-script-runner.ts';
import { loadFixtures } from '../../../../scripts/eval/load-fixtures.ts';
import { checkFixture, runOracle } from '../../../../scripts/eval/oracle.ts';
import { materialize } from '../../../../scripts/eval/workspace.ts';
import type { Fixture } from '../../../../scripts/eval/types.ts';
import { makeTmpRoot } from '../../../fixtures/tmp-root.ts';
import { writeMiniFixtures } from '../../../fixtures/eval-harness.ts';

let scratch: string;
let cleanup: () => Promise<void>;
let root: string;

const git = createGitRunner();
const shell = createShellScriptRunner();
const deps = { workspace: { git, tmpRoot: '' }, oracle: { shell } };

beforeEach(async () => {
  const tmp = await makeTmpRoot();
  scratch = String(tmp.root);
  cleanup = tmp.cleanup;
  root = await writeMiniFixtures(join(scratch, 'fixtures'));
  deps.workspace.tmpRoot = join(scratch, 'ws');
  await fs.mkdir(deps.workspace.tmpRoot, { recursive: true });
});
afterEach(async () => {
  await cleanup();
});

const fixtureOf = async (id: string): Promise<Fixture> => {
  const loaded = await loadFixtures(root, { idGlob: id });
  if (!loaded.ok) throw new Error(loaded.error.message);
  return loaded.value.fixtures[0] as Fixture;
};

const check = async (fixture: Fixture) => {
  const checked = await checkFixture(deps, fixture);
  if (!checked.ok) throw checked.error;
  return checked.value;
};

describe('checkFixture — label proof', () => {
  it.each(['mini-ev', 'mini-im', 'mini-ds', 'mini-sc'])('proves the labels of %s', async (id) => {
    const outcome = await check(await fixtureOf(id));
    expect(outcome.ok).toBe(true);
    expect(outcome.lines.length).toBeGreaterThan(0);
  });

  it('rejects a defect variant the oracle cannot observe (a possible equivalent mutant)', async () => {
    const dir = join(root, 'evaluate', 'mini-ev', 'variants');
    await fs.copyFile(join(dir, 'clean.patch'), join(dir, 'defect.patch'));
    const outcome = await check(await fixtureOf('mini-ev'));
    expect(outcome.ok).toBe(false);
    expect(outcome.lines.join('\n')).toContain('FAIL variant defect: oracle passed, expected fail');
  });

  it('rejects a clean variant the oracle fails', async () => {
    const dir = join(root, 'evaluate', 'mini-ev', 'variants');
    await fs.copyFile(join(dir, 'defect.patch'), join(dir, 'clean.patch'));
    const outcome = await check(await fixtureOf('mini-ev'));
    expect(outcome.ok).toBe(false);
    expect(outcome.lines.join('\n')).toContain('FAIL variant clean');
  });

  it('rejects an implement fixture whose reference patch does not solve it', async () => {
    const dir = join(root, 'implement', 'mini-im', 'variants');
    await fs.writeFile(join(dir, 'reference.patch'), '');
    const outcome = await check(await fixtureOf('mini-im'));
    expect(outcome.ok).toBe(false);
    expect(outcome.lines.join('\n')).toContain('reference patch');
  });

  it('rejects a select-candidate fixture whose declared loser actually passes', async () => {
    const dir = join(root, 'select-candidate', 'mini-sc', 'candidates');
    await fs.copyFile(join(dir, 'a.patch'), join(dir, 'b.patch'));
    const outcome = await check(await fixtureOf('mini-sc'));
    expect(outcome.ok).toBe(false);
    expect(outcome.lines.join('\n')).toContain('loser b');
  });

  it('rejects a detect-scripts fixture whose broken patch does not break the expected script', async () => {
    const dir = join(root, 'detect-scripts', 'mini-ds', 'variants');
    await fs.writeFile(join(dir, 'broken.patch'), '');
    const outcome = await check(await fixtureOf('mini-ds'));
    expect(outcome.ok).toBe(false);
    expect(outcome.lines.join('\n')).toContain('broken copy');
  });

  it('accepts a reviewer-labelled evaluate fixture without running anything', async () => {
    const specPath = join(root, 'evaluate', 'mini-ev', 'fixture.json');
    const spec = JSON.parse(await fs.readFile(specPath, 'utf8')) as Record<string, unknown>;
    await fs.writeFile(specPath, JSON.stringify({ ...spec, oracle: { kind: 'none', reviewedBy: ['alice', 'bob'] } }));
    const outcome = await check(await fixtureOf('mini-ev'));
    expect(outcome).toMatchObject({ ok: true });
    expect(outcome.lines[0]).toContain('alice, bob');
  });
});

describe('runOracle', () => {
  it('restores protected paths from the pristine repo before running, so a weakened test still fails', async () => {
    const dir = join(root, 'implement', 'mini-im');
    await fs.writeFile(join(dir, 'repo', 'test.mjs'), 'export const pristine = true;\n');
    const fixture = await fixtureOf('mini-im');
    const ws = await materialize(deps.workspace, fixture.dir);
    if (!ws.ok) throw ws.error;
    try {
      await fs.writeFile(join(String(ws.value.repo), 'test.mjs'), 'export const pristine = false;\n');
      const oracle = { command: 'grep -q "pristine = true" test.mjs', protectedPaths: ['test.mjs'] };
      const ran = await runOracle({ shell }, ws.value, fixture.dir, oracle);
      expect(ran.ok && ran.value.passed).toBe(true);
      expect(await fs.readFile(join(String(ws.value.repo), 'test.mjs'), 'utf8')).toContain('pristine = true');
    } finally {
      await ws.value.cleanup();
    }
  });

  it('refuses a protected path that escapes the workspace instead of deleting outside it', async () => {
    const fixture = await fixtureOf('mini-im');
    const ws = await materialize(deps.workspace, fixture.dir);
    if (!ws.ok) throw ws.error;
    const sentinel = join(String(ws.value.repo), '..', 'sentinel.txt');
    await fs.writeFile(sentinel, 'keep me');
    try {
      for (const escape of ['../sentinel.txt', sentinel, '.']) {
        const ran = await runOracle({ shell }, ws.value, fixture.dir, { command: 'true', protectedPaths: [escape] });
        expect(ran.ok, escape).toBe(false);
        expect(!ran.ok && ran.error.message).toContain('escapes the workspace');
      }
      expect(await fs.readFile(sentinel, 'utf8')).toBe('keep me');
      expect((await fs.stat(String(ws.value.repo))).isDirectory()).toBe(true);
    } finally {
      await ws.value.cleanup();
      await fs.rm(sentinel, { force: true });
    }
  });

  it('copies the oracle into the workspace only when grading', async () => {
    const fixture = await fixtureOf('mini-im');
    const ws = await materialize(deps.workspace, fixture.dir);
    if (!ws.ok) throw ws.error;
    try {
      const exists = (): Promise<boolean> =>
        fs.stat(join(String(ws.value.repo), 'oracle')).then(
          () => true,
          () => false
        );
      expect(await exists()).toBe(false);
      await runOracle({ shell }, ws.value, fixture.dir, { command: 'true', protectedPaths: [] });
      expect(await exists()).toBe(true);
    } finally {
      await ws.value.cleanup();
    }
  });
});

describe('materialize', () => {
  it('commits the base repo and leaves the variant patch uncommitted', async () => {
    const fixture = await fixtureOf('mini-ev');
    const ws = await materialize(deps.workspace, fixture.dir, 'variants/clean.patch');
    if (!ws.ok) throw ws.error;
    try {
      const status = await git.run(ws.value.repo, ['status', '--porcelain']);
      expect(status.ok && status.value.stdout.trim()).toBe('?? src/inc.mjs');
      const log = await git.run(ws.value.repo, ['log', '--format=%s']);
      expect(log.ok && log.value.stdout.trim()).toBe('base');
    } finally {
      await ws.value.cleanup();
    }
  });

  it('treats an empty patch as an empty working tree', async () => {
    const fixture = await fixtureOf('mini-ev');
    await fs.writeFile(join(fixture.dir, 'variants', 'defect.patch'), '');
    const ws = await materialize(deps.workspace, fixture.dir, 'variants/defect.patch');
    if (!ws.ok) throw ws.error;
    try {
      const status = await git.run(ws.value.repo, ['status', '--porcelain']);
      expect(status.ok && status.value.stdout.trim()).toBe('');
    } finally {
      await ws.value.cleanup();
    }
  });

  it('fails cleanly, leaving no temp directory, when the patch does not apply', async () => {
    const fixture = await fixtureOf('mini-ev');
    await fs.writeFile(join(fixture.dir, 'variants', 'defect.patch'), 'not a patch at all\n');
    const ws = await materialize(deps.workspace, fixture.dir, 'variants/defect.patch');
    expect(ws.ok).toBe(false);
    expect(await fs.readdir(deps.workspace.tmpRoot)).toEqual([]);
  });
});
