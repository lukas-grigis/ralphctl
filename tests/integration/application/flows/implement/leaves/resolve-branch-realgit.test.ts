/**
 * A cancel while `git checkout` sits in a hung post-checkout hook must end the resolve-branch leaf
 * at once, through the real git runner, instead of waiting out the hook-length budget.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { createSprintExecution, setExecutionBranch } from '@src/domain/entity/sprint-execution.ts';
import type { InteractivePrompt } from '@src/business/interactive/prompt.ts';
import { createGitRunner } from '@src/integration/io/git-runner.ts';
import { resolveBranchLeaf } from '@src/application/flows/implement/leaves/resolve-branch.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import { createFakeProject, type FakeProject } from '@tests/helpers/fake-project.ts';
import { absolutePath } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { isAlive, killQuietly, waitForDeath } from '@tests/helpers/process-tree.ts';

const sprintId = ((): SprintId => {
  const r = SprintId.parse('0193ed2b-1234-7abc-8def-0123456789ab');
  if (!r.ok) throw new Error('test setup');
  return r.value;
})();

const noPrompt = new Proxy({} as InteractivePrompt, {
  get: () => () => {
    throw new Error('the branch is already resolved — no prompt expected');
  },
});

describe.skipIf(process.platform === 'win32')('resolve-branch against a real repo', () => {
  let project: FakeProject;
  let hooksDir: string;
  const leftovers: number[] = [];

  beforeEach(async () => {
    project = await createFakeProject({ seed: { 'a.txt': 'one\n' } });
    hooksDir = mkdtempSync(join(tmpdir(), 'ralphctl-hooks-'));
    await project.git('config', 'core.hooksPath', hooksDir);
  });

  afterEach(async () => {
    killQuietly(leftovers.splice(0));
    rmSync(hooksDir, { recursive: true, force: true });
    await project.cleanup();
  });

  it('a cancel during a hung post-checkout hook ends the leaf promptly and reaps the hook', async () => {
    const pidFile = join(hooksDir, 'hook.pid');
    writeFileSync(join(hooksDir, 'post-checkout'), `#!/bin/sh\necho $$ > '${pidFile}'\nsleep 60\n`, {
      mode: 0o755,
    });
    const execution = setExecutionBranch(createSprintExecution({ sprintId }), 'ralphctl/cancel-me');
    const leaf = resolveBranchLeaf(
      {
        gitRunner: createGitRunner(),
        sprintExecutionRepo: { save: () => Promise.resolve(Result.ok(undefined)) },
        interactive: noPrompt,
        logger: noopLogger,
      },
      { cwds: [absolutePath(project.path)] }
    );
    const ctx: ImplementCtx = { sprintId, execution };
    const controller = new AbortController();

    const pending = leaf.execute(ctx, controller.signal);
    await vi.waitFor(
      () => {
        if (!existsSync(pidFile) || readFileSync(pidFile, 'utf8').trim() === '') throw new Error('hook not started');
      },
      { timeout: 5_000 }
    );
    const hookPid = Number(readFileSync(pidFile, 'utf8').trim());
    leftovers.push(hookPid);
    const cancelledAt = Date.now();
    controller.abort();
    const result = await pending;

    expect(Date.now() - cancelledAt).toBeLessThan(5_000);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error).toBeInstanceOf(AbortError);
    expect(await waitForDeath([hookPid], 5_000)).toBe(true);
    expect(isAlive(hookPid)).toBe(false);
  }, 20_000);
});
