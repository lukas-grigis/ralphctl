/**
 * Real-git round trip for the NUL-separated status snapshot and the path-scoped discard: the two
 * primitives the parallel implement path uses to undo what a setup script wrote into a task's
 * worktree without touching anything else in it. Scripted runners can only assert the argv; this
 * test proves the argv actually does the job, including under `status.showUntrackedFiles=no`.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { createGitRunner, type GitRunner } from '@src/integration/io/git-runner.ts';
import {
  gitDiscardEntries,
  gitStatusSnapshot,
  porcelainEntryKey,
  type PorcelainEntry,
} from '@src/integration/io/git-tree-snapshot.ts';
import { createFakeProject, type FakeProject } from '@tests/helpers/fake-project.ts';

const abs = (p: string): AbsolutePath => {
  const r = AbsolutePath.parse(p);
  if (!r.ok) throw new Error(`test setup: bad path ${p}`);
  return r.value;
};

const snapshot = async (runner: GitRunner, cwd: AbsolutePath): Promise<readonly PorcelainEntry[]> => {
  const snap = await gitStatusSnapshot(runner, cwd);
  if (!snap.ok) throw new Error(`snapshot failed: ${snap.error.message}`);
  return snap.value;
};

describe('git tree snapshot + discard against a real repository', () => {
  let project: FakeProject;
  let cwd: AbsolutePath;
  let runner: GitRunner;

  beforeEach(async () => {
    project = await createFakeProject({
      seed: {
        '.gitignore': 'node_modules/\n',
        'keep.txt': 'keep v1\n',
        'lock.txt': 'lock v1\n',
        'moved-from.txt': 'moved\n',
      },
    });
    await project.git('config', 'status.showUntrackedFiles', 'no');
    cwd = abs(project.path);
    runner = createGitRunner();
  });

  afterEach(async () => {
    await project.cleanup();
  });

  it('sees untracked entries despite status.showUntrackedFiles=no, with paths unquoted', async () => {
    await project.writeFile('gen/sub/f.ts', 'export {};\n');
    await project.writeFile('sp ace "q" ü.txt', 'x\n');

    const entries = await snapshot(runner, cwd);

    expect(entries).toStrictEqual([
      { xy: '??', path: 'gen/' },
      { xy: '??', path: 'sp ace "q" ü.txt' },
    ]);
  });

  it('discards exactly the introduced entries and leaves prior dirt and ignored files alone', async () => {
    await project.writeFile('keep.txt', 'keep v2 — operator work in progress\n');
    await project.writeFile('node_modules/x/index.js', 'module.exports = 1;\n');
    const before = new Set((await snapshot(runner, cwd)).map(porcelainEntryKey));

    // What a setup script might leave behind: a rewritten tracked file, generated output in a new
    // directory, an oddly named file, a staged new file, and a staged rename.
    await project.writeFile('lock.txt', 'lock v2\n');
    await project.writeFile('gen/sub/f.ts', 'export {};\n');
    await project.writeFile('sp ace.txt', 'x\n');
    await project.writeFile('staged-new.txt', 'new\n');
    await project.git('add', 'staged-new.txt');
    await project.git('mv', 'moved-from.txt', 'moved-to.txt');

    const after = await snapshot(runner, cwd);
    const introduced = after.filter((e) => !before.has(porcelainEntryKey(e)));
    expect(introduced.find((e) => e.path === 'moved-to.txt')).toStrictEqual({
      xy: 'R ',
      path: 'moved-to.txt',
      origPath: 'moved-from.txt',
    });

    const discarded = await gitDiscardEntries(runner, cwd, introduced);
    expect(discarded.ok).toBe(true);

    expect(await snapshot(runner, cwd)).toStrictEqual([{ xy: ' M', path: 'keep.txt' }]);
    expect(await project.readFile('keep.txt')).toBe('keep v2 — operator work in progress\n');
    expect(await project.readFile('lock.txt')).toBe('lock v1\n');
    expect(await project.readFile('moved-from.txt')).toBe('moved\n');
    await expect(fs.access(join(project.path, 'staged-new.txt'))).rejects.toThrow();
    await expect(fs.access(join(project.path, 'gen'))).rejects.toThrow();
    await expect(fs.access(join(project.path, 'node_modules/x/index.js'))).resolves.toBeUndefined();
  });

  it('reports a failed discard instead of pretending the tree is clean', async () => {
    const out = await gitDiscardEntries(runner, cwd, [{ xy: ' M', path: 'no-such-file.txt' }]);

    expect(out.ok).toBe(false);
  });
});
