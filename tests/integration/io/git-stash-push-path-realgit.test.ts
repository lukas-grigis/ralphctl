/**
 * Real-git coverage for `gitStashPushPath`: one path moves into the stash whether it is untracked or
 * tracked, everything else stays put, and git reads the path literally.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { createGitRunner } from '@src/integration/io/git-runner.ts';
import { gitStashInspect, gitStashList, gitStashPush, gitStashPushPath } from '@src/integration/io/git-stash.ts';
import { createFakeProject, type FakeProject } from '@tests/helpers/fake-project.ts';

const MSG = 'ralphctl/s1/t1/discarded-reproduction';

const abs = (p: string): AbsolutePath => {
  const r = AbsolutePath.parse(p);
  if (!r.ok) throw new Error(`test setup: bad path ${p}`);
  return r.value;
};

describe('gitStashPushPath (real git)', () => {
  let project: FakeProject;
  let cwd: AbsolutePath;
  const runner = createGitRunner();

  beforeEach(async () => {
    project = await createFakeProject({ seed: { 'a.txt': 'one\n', 'b.txt': 'two\n' } });
    cwd = abs(project.path);
  });

  afterEach(async () => {
    await project.cleanup();
  });

  const porcelain = (): Promise<string> => project.git('status', '--porcelain', '--untracked-files=all');

  it('moves a new untracked file in a new directory, and pop brings it back', async () => {
    await project.writeFile('tests/new/foo.test.ts', 'new\n');

    const pushed = await gitStashPushPath(runner, cwd, MSG, 'tests/new/foo.test.ts');

    expect(pushed.ok && pushed.value).toEqual({ stashed: true });
    expect(await porcelain()).toBe('');
    await project.git('stash', 'pop');
    expect(await project.readFile('tests/new/foo.test.ts')).toBe('new\n');
  });

  it('moves an edit to a tracked file, back to the committed copy', async () => {
    await project.writeFile('a.txt', 'one\nedited\n');

    const pushed = await gitStashPushPath(runner, cwd, MSG, 'a.txt');

    expect(pushed.ok && pushed.value).toEqual({ stashed: true });
    expect(await project.readFile('a.txt')).toBe('one\n');
    const inspected = await gitStashInspect(runner, cwd, MSG);
    expect(inspected.ok && inspected.value.newest?.stat).toEqual({ files: 1, insertions: 1, deletions: 0 });
  });

  it('leaves every other change alone, staged or not', async () => {
    await project.writeFile('a.txt', 'one\nedited\n');
    await project.writeFile('b.txt', 'two\nstaged\n');
    await project.git('add', 'b.txt');
    await project.writeFile('other.txt', 'untracked\n');
    await project.writeFile('tests/foo.test.ts', 'new\n');

    expect((await gitStashPushPath(runner, cwd, MSG, 'tests/foo.test.ts')).ok).toBe(true);

    expect(await porcelain()).toBe(' M a.txt\nM  b.txt\n?? other.txt\n');
    expect(await project.readFile('a.txt')).toBe('one\nedited\n');
  });

  it('reads the path literally: glob characters and a leading dash are just a file name', async () => {
    await project.writeFile('tests/[id]/route.test.ts', 'bracket\n');
    await project.writeFile('tests/i/route.test.ts', 'matched by the glob reading\n');
    await project.writeFile('-u.test.ts', 'dash\n');

    expect((await gitStashPushPath(runner, cwd, MSG, 'tests/[id]/route.test.ts')).ok).toBe(true);
    expect((await gitStashPushPath(runner, cwd, MSG, '-u.test.ts')).ok).toBe(true);

    expect(await porcelain()).toBe('?? tests/i/route.test.ts\n');
  });

  it('reads the path relative to a cwd below the repo root', async () => {
    await project.writeFile('pkg/sub/foo.test.ts', 'new\n');
    await project.writeFile('foo.test.ts', 'same name at the root\n');

    const pushed = await gitStashPushPath(runner, abs(`${project.path}/pkg/sub`), MSG, 'foo.test.ts');

    expect(pushed.ok && pushed.value).toEqual({ stashed: true });
    expect(await porcelain()).toBe('?? foo.test.ts\n');
  });

  it.each([
    ['is unchanged', 'a.txt'],
    ['does not exist', 'nope/nope.test.ts'],
  ])('no-ops with stashed:false when the path %s, even on a dirty tree', async (_label, path) => {
    await project.writeFile('b.txt', 'two\nedited\n');

    const pushed = await gitStashPushPath(runner, cwd, MSG, path);

    expect(pushed.ok && pushed.value).toEqual({ stashed: false });
    const listed = await gitStashList(runner, cwd);
    expect(listed.ok && listed.value).toEqual([]);
    expect(await porcelain()).toBe(' M b.txt\n');
  });

  it('ignores a repo that hides untracked files from status', async () => {
    await project.git('config', 'status.showUntrackedFiles', 'no');
    await project.writeFile('tests/foo.test.ts', 'new\n');

    const pushed = await gitStashPushPath(runner, cwd, MSG, 'tests/foo.test.ts');

    expect(pushed.ok && pushed.value).toEqual({ stashed: true });
  });

  it('stacks on the shared list without disturbing an earlier entry', async () => {
    await project.writeFile('a.txt', 'one\nolder\n');
    expect((await gitStashPush(runner, cwd, 'ralphctl/s1/t1/blocked-diff')).ok).toBe(true);
    await project.writeFile('tests/foo.test.ts', 'new\n');

    expect((await gitStashPushPath(runner, cwd, MSG, 'tests/foo.test.ts')).ok).toBe(true);

    const inspected = await gitStashInspect(runner, cwd, 'ralphctl/s1/t1/blocked-diff');
    expect(inspected.ok && inspected.value.entries).toBe(1);
    expect(inspected.ok && inspected.value.newest?.ref).toBe('stash@{1}');
  });
});
