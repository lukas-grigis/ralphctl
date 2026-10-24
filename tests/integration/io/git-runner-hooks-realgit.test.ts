/**
 * Real-git coverage for how the runner bounds git verbs that run user hooks: the wait is bounded by
 * git's own exit (not by whoever still holds its pipes), a timeout or abort reaps the hook too, the
 * hook-bearing verbs get a hook-length budget, and git never prompts on the harness terminal.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { createGitRunner } from '@src/integration/io/git-runner.ts';
import { gitCommitWithMessage } from '@src/integration/io/git-operations.ts';
import { createFakeProject, type FakeProject } from '@tests/helpers/fake-project.ts';

const abs = (p: string): AbsolutePath => {
  const r = AbsolutePath.parse(p);
  if (!r.ok) throw new Error(`test setup: bad path ${p}`);
  return r.value;
};

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe.skipIf(process.platform === 'win32')('git runner with real hooks', () => {
  let project: FakeProject;
  let cwd: AbsolutePath;
  let hooksDir: string;
  const hookPids: number[] = [];

  beforeEach(async () => {
    project = await createFakeProject({ seed: { 'a.txt': 'one\n' } });
    cwd = abs(project.path);
    hooksDir = mkdtempSync(join(tmpdir(), 'ralphctl-hooks-'));
    await project.git('config', 'core.hooksPath', hooksDir);
  });

  afterEach(async () => {
    for (const pid of hookPids.splice(0)) if (isAlive(pid)) process.kill(pid, 'SIGKILL');
    rmSync(hooksDir, { recursive: true, force: true });
    await project.cleanup();
  });

  const writeHook = (name: string, body: string): void => {
    writeFileSync(join(hooksDir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  };

  const stageEdit = async (): Promise<void> => {
    await project.writeFile('a.txt', 'two\n');
    await project.git('add', '-A');
  };

  const readPid = (file: string): number => {
    const pid = Number(readFileSync(file, 'utf8').trim());
    hookPids.push(pid);
    return pid;
  };

  it('settles on git exit when a hook leaves a background job holding the pipes', async () => {
    writeHook('pre-commit', 'sleep 4 &\nexit 0');
    await stageEdit();
    const runner = createGitRunner();

    const started = Date.now();
    const result = await runner.run(cwd, ['commit', '-m', 'msg']);
    const elapsed = Date.now() - started;

    if (!result.ok) throw result.error;
    expect(result.value.exitCode).toBe(0);
    expect(elapsed).toBeLessThan(3_000);
    expect((await project.git('log', '--format=%s', '-1')).trim()).toBe('msg');
  });

  it('reaps the running hook when the timeout trips, and settles promptly', async () => {
    const pidFile = join(hooksDir, 'hook.pid');
    writeHook('pre-commit', `echo $$ > '${pidFile}'\nsleep 30`);
    await stageEdit();
    const runner = createGitRunner();

    const started = Date.now();
    // Headroom for git to reach the hook under suite load: a timeout before the hook starts leaves nothing to reap.
    const result = await runner.run(cwd, ['commit', '-m', 'msg'], { timeoutMs: 2_000 });
    const elapsed = Date.now() - started;

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('timed out');
    expect(elapsed).toBeLessThan(6_500);
    const pid = readPid(pidFile);
    await vi.waitFor(() => {
      expect(isAlive(pid)).toBe(false);
    });
  });

  it('reaps the running hook when the caller aborts', async () => {
    const pidFile = join(hooksDir, 'hook.pid');
    writeHook('pre-commit', `echo $$ > '${pidFile}'\nsleep 30`);
    await stageEdit();
    const runner = createGitRunner();
    const controller = new AbortController();

    const pending = runner.run(cwd, ['commit', '-m', 'msg'], { signal: controller.signal });
    await vi.waitFor(() => {
      if (!existsSync(pidFile) || readFileSync(pidFile, 'utf8').trim() === '') throw new Error('hook not started');
    });
    controller.abort();
    const result = await pending;

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('aborted');
    const pid = readPid(pidFile);
    await vi.waitFor(() => {
      expect(isAlive(pid)).toBe(false);
    });
  });

  it('gives a commit hook more than the default probe budget', async () => {
    writeHook('pre-commit', 'sleep 1');
    await project.writeFile('a.txt', 'two\n');
    const runner = createGitRunner({ defaultTimeoutMs: 400 });

    const result = await gitCommitWithMessage(runner, cwd, 'slow hook');

    if (!result.ok) throw result.error;
    expect(result.value.committed).toBe(true);
  });

  it('runs git with terminal prompts disabled', async () => {
    const envFile = join(hooksDir, 'env.txt');
    writeHook('pre-commit', `printf '%s' "$GIT_TERMINAL_PROMPT" > '${envFile}'`);
    await stageEdit();

    const result = await createGitRunner().run(cwd, ['commit', '-m', 'msg']);

    if (!result.ok) throw result.error;
    expect(readFileSync(envFile, 'utf8')).toBe('0');
  });
});
