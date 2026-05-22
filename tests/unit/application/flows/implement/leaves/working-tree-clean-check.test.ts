import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { workingTreeCleanCheckLeaf } from '@src/application/flows/implement/leaves/working-tree-clean-check.ts';
import { absolutePath, makeInProgressTaskWithRunningAttempt } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import type { GitRunner } from '@src/integration/io/git-runner.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import { SprintId } from '@src/domain/value/id/sprint-id.ts';

const CWD = absolutePath('/tmp/wtc-repo');

const baseCtx = (): ImplementCtx => {
  const sid = SprintId.parse('0193ed2b-1234-7abc-8def-0123456789ab');
  if (!sid.ok) throw new Error('test setup');
  return { sprintId: sid.value };
};

const okGit = (stdout: string, exitCode = 0): GitRunner => ({
  async run() {
    return Result.ok({ stdout, stderr: '', exitCode });
  },
});

describe('workingTreeCleanCheckLeaf', () => {
  it('passes through a clean tree (empty porcelain stdout)', async () => {
    const el = workingTreeCleanCheckLeaf({ gitRunner: okGit(''), logger: noopLogger }, CWD);
    const out = await el.execute(baseCtx());
    expect(out.ok).toBe(true);
  });

  it('rejects a dirty tree with InvalidStateError and `working-tree-dirty` in the message', async () => {
    const el = workingTreeCleanCheckLeaf({ gitRunner: okGit(' M file\n'), logger: noopLogger }, CWD);
    const out = await el.execute(baseCtx());
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.error.code).toBe('invalid-state');
      expect(out.error.error.message).toContain('working-tree-dirty');
      expect(out.error.error.message).toContain(String(CWD));
    }
  });

  it('surfaces a clear InvalidStateError on git status non-zero exit', async () => {
    const runner: GitRunner = {
      async run() {
        return Result.ok({ stdout: '', stderr: 'fatal: not a git repository', exitCode: 128 });
      },
    };
    const el = workingTreeCleanCheckLeaf({ gitRunner: runner, logger: noopLogger }, CWD);
    const out = await el.execute(baseCtx());
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.error.code).toBe('invalid-state');
      expect(out.error.error.message).toContain('git status failed');
    }
  });

  it('downgrades dirty-tree to a pass-through when ctx.tasks shows a resuming task (in_progress + running last attempt)', async () => {
    const el = workingTreeCleanCheckLeaf({ gitRunner: okGit(' M file\n'), logger: noopLogger }, CWD);
    const resuming = makeInProgressTaskWithRunningAttempt();
    const out = await el.execute({ ...baseCtx(), tasks: [resuming] });
    // Dirt belongs to the prior crashed attempt — preflight-task downstream owns the recovery
    // menu, so this leaf must NOT hard-abort the chain. A fresh run with no resume signature
    // still hard-aborts (covered by the `rejects a dirty tree …` test above).
    expect(out.ok).toBe(true);
  });

  it('forwards opts.label onto the element + emitted trace entry', async () => {
    const el = workingTreeCleanCheckLeaf(
      { gitRunner: okGit(''), logger: noopLogger },
      CWD,
      'working-tree-clean-check-1',
      {
        label: 'working-tree clean · repo',
      }
    );
    expect(el.name).toBe('working-tree-clean-check-1');
    expect(el.label).toBe('working-tree clean · repo');
    const out = await el.execute(baseCtx());
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.trace[0]?.elementName).toBe('working-tree-clean-check-1');
      expect(out.value.trace[0]?.label).toBe('working-tree clean · repo');
    }
  });
});
