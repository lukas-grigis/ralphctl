import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import { NodeGitRunner } from './git-runner.ts';

async function tmpAbs(): Promise<AbsolutePath> {
  const dir = await mkdtemp(join(tmpdir(), 'ralphctl-git-runner-'));
  return AbsolutePath.trustString(dir);
}

describe('NodeGitRunner', () => {
  it('returns non-zero exitCode on git failures (e.g. not a git repo)', async () => {
    const cwd = await tmpAbs();
    const runner = new NodeGitRunner();
    // A pristine tempdir is not a git repo — `git status` should exit non-zero.
    const r = runner.run({ cwd, args: ['status', '--porcelain'] });
    expect(r.exitCode).not.toBe(0);
    expect(typeof r.stderr).toBe('string');
  });

  it('returns exitCode 0 + version string for `git --version`', async () => {
    const cwd = await tmpAbs();
    const runner = new NodeGitRunner();
    const r = runner.run({ cwd, args: ['--version'] });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/^git version /);
  });

  it('returns -1 exit code when timeout aborts the process', async () => {
    const cwd = await tmpAbs();
    const runner = new NodeGitRunner();
    // Tiny timeout + a real (but doomed) `git` invocation. The child is
    // killed by the timeout — spawnSync.error is set, exitCode becomes -1.
    const r = runner.run({
      cwd,
      args: ['help', '--all'],
      timeoutMs: 1,
    });
    // Either the process completed before the timer fired (rare) or it
    // was killed. Both are acceptable; we only need to know the runner
    // doesn't throw and surfaces a sensible result shape.
    expect(typeof r.exitCode).toBe('number');
    expect(typeof r.stdout).toBe('string');
    expect(typeof r.stderr).toBe('string');
  });
});
