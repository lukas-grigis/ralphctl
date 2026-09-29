import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Tiny on-disk fixture sets for the eval-harness tests. Real git + node run against them (no AI):
 * the patches below are hand-written unified diffs, small enough to read, so a test never depends
 * on the shipped `evals/fixtures/` content.
 */

const INC = (n: number): string => `export const inc = (x) => x + ${String(n)};\n`;

const newFilePatch = (path: string, body: string): string =>
  [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    'index 0000000..1111111',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1 @@`,
    `+${body.trimEnd()}`,
    '',
  ].join('\n');

/** A one-line edit of `src/inc.mjs` from `x + from` to `x + to`. */
const incEditPatch = (from: number, to: number): string =>
  [
    'diff --git a/src/inc.mjs b/src/inc.mjs',
    'index 1111111..2222222 100644',
    '--- a/src/inc.mjs',
    '+++ b/src/inc.mjs',
    '@@ -1 +1 @@',
    `-${INC(from).trimEnd()}`,
    `+${INC(to).trimEnd()}`,
    '',
  ].join('\n');

const ORACLE = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inc } from '../src/inc.mjs';

test('inc adds one', () => { assert.equal(inc(1), 2); });
`;

const INC_CMD = `node -e "import('./src/inc.mjs').then((m) => console.log(m.inc(1)))"`;

const TASK = {
  name: 'Add an inc helper',
  description: 'Add `inc(x)` in `src/inc.mjs` returning `x + 1`.',
  steps: ['Create src/inc.mjs exporting inc'],
  verificationCriteria: [{ id: 'C1', assertion: 'inc(1) prints 2', check: 'auto', command: INC_CMD }],
};

const COMMON = {
  schemaVersion: 1,
  tier: 'regression',
  cluster: 'mini',
  origin: 'synthetic',
  provenance: 'test fixture',
} as const;

const put = async (root: string, files: Readonly<Record<string, string>>): Promise<void> => {
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel);
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, content, 'utf8');
  }
};

const BASE_REPO = { 'package.json': '{ "type": "module", "scripts": { "test": "node --test test/*.test.mjs" } }\n' };

export type MiniFlow = 'evaluate' | 'implement' | 'detect-scripts' | 'select-candidate';

/**
 * Write one mini fixture per requested flow under `<root>/<flow>/mini-<xx>/`. Returns the fixtures
 * root. Ids: `mini-ev`, `mini-im`, `mini-ds`, `mini-sc`.
 */
export const writeMiniFixtures = async (
  root: string,
  flows: readonly MiniFlow[] = ['evaluate', 'implement', 'detect-scripts', 'select-candidate']
): Promise<string> => {
  if (flows.includes('evaluate')) {
    const dir = join(root, 'evaluate', 'mini-ev');
    await put(dir, {
      'repo/package.json': BASE_REPO['package.json'],
      'repo/src/base.mjs': 'export const one = 1;\n',
      'variants/clean.patch': newFilePatch('src/inc.mjs', INC(1)),
      'variants/defect.patch': newFilePatch('src/inc.mjs', INC(2)),
      'oracle/inc.test.mjs': ORACLE,
      'fixture.json': JSON.stringify({
        ...COMMON,
        id: 'mini-ev',
        flow: 'evaluate',
        task: TASK,
        variants: [
          { name: 'clean', patch: 'variants/clean.patch', expect: { status: 'passed' } },
          {
            name: 'defect',
            patch: 'variants/defect.patch',
            defectClass: 'correctness',
            expect: { status: 'failed', failedDimensions: ['correctness'], criteria: { C1: { passed: false } } },
          },
        ],
        oracle: { command: 'node --test oracle/*.test.mjs', protectedPaths: [] },
      }),
    });
  }
  if (flows.includes('implement')) {
    const dir = join(root, 'implement', 'mini-im');
    await put(dir, {
      'repo/package.json': BASE_REPO['package.json'],
      'repo/src/inc.mjs': INC(2),
      'variants/reference.patch': incEditPatch(2, 1),
      'oracle/inc.test.mjs': ORACLE,
      'fixture.json': JSON.stringify({
        ...COMMON,
        id: 'mini-im',
        flow: 'implement',
        task: TASK,
        referencePatch: 'variants/reference.patch',
        oracle: { command: 'node --test oracle/*.test.mjs', protectedPaths: [] },
      }),
    });
  }
  if (flows.includes('detect-scripts')) {
    const dir = join(root, 'detect-scripts', 'mini-ds');
    await put(dir, {
      'repo/package.json': BASE_REPO['package.json'],
      'repo/src/inc.mjs': INC(1),
      'repo/test/inc.test.mjs': ORACLE,
      'variants/broken.patch': incEditPatch(1, 2),
      'fixture.json': JSON.stringify({
        ...COMMON,
        id: 'mini-ds',
        flow: 'detect-scripts',
        brokenPatch: 'variants/broken.patch',
        expected: { verifyScript: 'node --test test/*.test.mjs' },
      }),
    });
  }
  if (flows.includes('select-candidate')) {
    const dir = join(root, 'select-candidate', 'mini-sc');
    const summary = (files: string[], verifyOutcome: string): string =>
      JSON.stringify({
        hadDiff: true,
        changedFiles: files,
        verifyOutcome,
        changesEmitted: ['edited inc'],
        notesEmitted: [],
      });
    await put(dir, {
      'repo/package.json': BASE_REPO['package.json'],
      'repo/src/inc.mjs': INC(2),
      'candidates/a.patch': incEditPatch(2, 1),
      'candidates/b.patch': incEditPatch(2, 3),
      'candidates/a.json': summary(['src/inc.mjs'], 'success'),
      'candidates/b.json': summary(['src/inc.mjs'], 'failed'),
      'oracle/inc.test.mjs': ORACLE,
      'fixture.json': JSON.stringify({
        ...COMMON,
        id: 'mini-sc',
        flow: 'select-candidate',
        task: TASK,
        candidates: {
          a: { summary: 'candidates/a.json', patch: 'candidates/a.patch' },
          b: { summary: 'candidates/b.json', patch: 'candidates/b.patch' },
        },
        winner: 'a',
        oracle: { command: 'node --test oracle/*.test.mjs', protectedPaths: [] },
      }),
    });
  }
  return root;
};

/** A schema-valid evaluate spec object, for schema tests that mutate one field at a time. */
export const evaluateSpec = (): Record<string, unknown> => ({
  ...COMMON,
  id: 'spec-ev',
  flow: 'evaluate',
  task: TASK,
  variants: [
    { name: 'clean', patch: 'variants/clean.patch', expect: { status: 'passed' } },
    {
      name: 'defect',
      patch: 'variants/defect.patch',
      defectClass: 'correctness',
      expect: { status: 'failed', failedDimensions: ['correctness'], criteria: { C1: { passed: false } } },
    },
  ],
  oracle: { command: 'node --test oracle/*.test.mjs', protectedPaths: [] },
});
