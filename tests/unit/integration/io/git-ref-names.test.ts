import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { generateBranchName } from '@src/integration/io/branch-name.ts';
import { gitWorktreeRef, legacyGitWorktreeRef } from '@src/integration/io/git-operations.ts';
import { gitRescueRef } from '@src/integration/io/git-ref-rescue.ts';

// Git stores refs as paths: `a` and `a/b` can't both exist, so `worktree add -b` fails outright.
const isPathPrefix = (a: string, b: string): boolean => b.startsWith(`${a}/`);
const collide = (a: string, b: string): boolean => a === b || isPathPrefix(a, b) || isPathPrefix(b, a);

const ID_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['01a10d01-6bf5-7001-b22b-2e49d002e19a', '01a10d01-8371-7003-ac06-fc50cae9c921'],
  ['s1', 't1'],
  ['s1', 's1'],
  ['abc', 'wt-abc'],
  ...Array.from({ length: 50 }, () => [randomUUID(), randomUUID()] as const),
];

describe('ralphctl-owned branch names never nest under one another', () => {
  it('builds the worktree ref in its own top-level namespace', () => {
    expect(gitWorktreeRef('sprint-abc', 'task-7')).toBe('ralphctl-wt/sprint-abc/task-7');
    expect(legacyGitWorktreeRef('sprint-abc', 'task-7')).toBe('ralphctl/sprint-abc/wt-task-7');
  });

  it.each(ID_PAIRS)('sprint %s / task %s: the sprint branch and the worktree ref can coexist', (sprintId, taskId) => {
    expect(collide(generateBranchName(sprintId), gitWorktreeRef(sprintId, taskId))).toBe(false);
  });

  it.each(ID_PAIRS)('sprint %s / task %s: a rescue ref collides with neither', (sprintId, taskId) => {
    const rescue = gitRescueRef(sprintId, taskId, '2026-10-05T12:34:56.789Z');
    expect(collide(rescue, generateBranchName(sprintId))).toBe(false);
    expect(collide(rescue, gitWorktreeRef(sprintId, taskId))).toBe(false);
  });

  it('the legacy shape is the one that collided — the fence would have caught it', () => {
    expect(collide(generateBranchName('s1'), legacyGitWorktreeRef('s1', 't1'))).toBe(true);
  });

  it('stamps the rescue ref with a compact UTC timestamp', () => {
    expect(gitRescueRef('s1', 't1', '2026-10-05T12:34:56.789Z')).toBe('ralphctl-rescue/s1/t1-20261005T123456Z');
  });
});
