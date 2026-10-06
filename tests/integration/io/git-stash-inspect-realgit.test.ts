/**
 * Real-git coverage for `gitStashInspect`: a `-u` stash's numstat must count tracked edits,
 * untracked files and binary files, report every entry under one message, and leave the stack alone.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { Result } from '@src/domain/result.ts';
import { createGitRunner, type GitRunner } from '@src/integration/io/git-runner.ts';
import { gitStashInspect, gitStashList, gitStashPush } from '@src/integration/io/git-stash.ts';
import { createFakeProject, type FakeProject } from '@tests/helpers/fake-project.ts';

const MSG = 'ralphctl/s1/t1/blocked-diff';

const abs = (p: string): AbsolutePath => {
  const r = AbsolutePath.parse(p);
  if (!r.ok) throw new Error(`test setup: bad path ${p}`);
  return r.value;
};

describe('gitStashInspect (real git)', () => {
  let project: FakeProject;
  let cwd: AbsolutePath;
  const runner = createGitRunner();

  beforeEach(async () => {
    project = await createFakeProject({ seed: { 'a.txt': 'one\ntwo\nthree\n' } });
    cwd = abs(project.path);
  });

  afterEach(async () => {
    await project.cleanup();
  });

  /** Edit a tracked file (+2 -1), add an untracked text file (+3) and an untracked binary file. */
  const dirtyTree = async (): Promise<void> => {
    await project.writeFile('a.txt', 'one\nTWO\nthree\nfour\n');
    await project.writeFile('src/new.ts', 'export const x = 1;\nexport const y = 2;\nexport const z = 3;\n');
    await fs.writeFile(join(project.path, 'logo.bin'), Buffer.from([0, 1, 2, 0, 255, 0, 3]));
  };

  it('measures tracked, untracked and binary files of the newest entry', async () => {
    await dirtyTree();
    const pushed = await gitStashPush(runner, cwd, MSG);
    expect(pushed.ok && pushed.value.stashed).toBe(true);

    const result = await gitStashInspect(runner, cwd, MSG);
    if (!result.ok) throw result.error;
    expect(result.value.entries).toBe(1);
    expect(result.value.newest?.ref).toBe('stash@{0}');
    expect(result.value.newest?.stat).toEqual({ files: 3, insertions: 5, deletions: 1 });
    const files = [...(result.value.newest?.files ?? [])].sort((x, y) => x.path.localeCompare(y.path));
    expect(files).toEqual([
      { path: 'a.txt', insertions: 2, deletions: 1 },
      { path: 'logo.bin', insertions: 0, deletions: 0, binary: true },
      { path: 'src/new.ts', insertions: 3, deletions: 0 },
    ]);
  });

  it('counts two entries under one message and reports the newest', async () => {
    await project.writeFile('a.txt', 'older\n');
    expect((await gitStashPush(runner, cwd, MSG)).ok).toBe(true);
    await project.writeFile('other.txt', 'unrelated\n');
    expect((await gitStashPush(runner, cwd, 'ralphctl/s1/t2/blocked-diff')).ok).toBe(true);
    await dirtyTree();
    expect((await gitStashPush(runner, cwd, MSG)).ok).toBe(true);

    const result = await gitStashInspect(runner, cwd, MSG);
    if (!result.ok) throw result.error;
    expect(result.value.entries).toBe(2);
    expect(result.value.newest?.ref).toBe('stash@{0}');
    expect(result.value.newest?.stat.files).toBe(3);
  });

  it('leaves the stash stack untouched', async () => {
    await dirtyTree();
    expect((await gitStashPush(runner, cwd, MSG)).ok).toBe(true);
    const before = await gitStashList(runner, cwd);
    expect((await gitStashInspect(runner, cwd, MSG)).ok).toBe(true);
    expect(await gitStashList(runner, cwd)).toEqual(before);
  });

  it('reports no entries on an empty stash', async () => {
    const result = await gitStashInspect(runner, cwd, MSG);
    expect(result.ok && result.value).toEqual({ entries: 0 });
  });

  it('falls back to a tracked-only partial stat when git rejects --include-untracked', async () => {
    await dirtyTree();
    expect((await gitStashPush(runner, cwd, MSG)).ok).toBe(true);
    const oldGit: GitRunner = {
      run: (dir, args, opts) =>
        args.includes('--include-untracked')
          ? Promise.resolve(
              Result.ok({ stdout: '', stderr: "error: unknown option `include-untracked'", exitCode: 129 })
            )
          : runner.run(dir, args, opts),
    };

    const result = await gitStashInspect(oldGit, cwd, MSG);
    if (!result.ok) throw result.error;
    expect(result.value.newest?.stat).toEqual({ files: 1, insertions: 2, deletions: 1, partial: true });
  });
});
