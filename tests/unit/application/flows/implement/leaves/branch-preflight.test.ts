import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { absolutePath } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { branchPreflightLeaf } from '@src/application/flows/implement/leaves/branch-preflight.ts';
import type { GitRunner } from '@src/integration/io/git-runner.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import { SprintId } from '@src/domain/value/id/sprint-id.ts';

const CWD = absolutePath('/tmp/repo');

const baseCtx = (overrides: Partial<ImplementCtx> = {}): ImplementCtx => {
  const sid = SprintId.parse('0193ed2b-1234-7abc-8def-0123456789ab');
  if (!sid.ok) throw new Error('test setup');
  return { sprintId: sid.value, ...overrides };
};

const fakeBranchRunner = (branchName: string, exitCode = 0): GitRunner => ({
  async run() {
    return Result.ok({ stdout: `${branchName}\n`, stderr: '', exitCode });
  },
});

describe('branchPreflightLeaf', () => {
  it('no-ops when ctx.expectedBranch is undefined (no expectation to enforce)', async () => {
    const leaf = branchPreflightLeaf({ gitRunner: fakeBranchRunner('main'), logger: noopLogger }, { cwd: CWD });
    const out = await leaf.execute(baseCtx());
    expect(out.ok).toBe(true);
  });

  it('passes when the working tree is on the expected branch', async () => {
    const leaf = branchPreflightLeaf(
      { gitRunner: fakeBranchRunner('ralphctl/sprint-42'), logger: noopLogger },
      { cwd: CWD }
    );
    const out = await leaf.execute(baseCtx({ expectedBranch: 'ralphctl/sprint-42' }));
    expect(out.ok).toBe(true);
  });

  it('halts with InvalidStateError when the working tree drifted to a different branch', async () => {
    const leaf = branchPreflightLeaf({ gitRunner: fakeBranchRunner('feature/wat'), logger: noopLogger }, { cwd: CWD });
    const out = await leaf.execute(baseCtx({ expectedBranch: 'ralphctl/sprint-42' }));
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.error.code).toBe('invalid-state');
      expect(out.error.error.message).toContain("expected 'ralphctl/sprint-42'");
      expect(out.error.error.message).toContain("got 'feature/wat'");
    }
  });

  it('propagates StorageError when git rev-parse fails', async () => {
    const runner: GitRunner = {
      async run() {
        return Result.ok({ stdout: '', stderr: 'fatal: not a git repo', exitCode: 128 });
      },
    };
    const leaf = branchPreflightLeaf({ gitRunner: runner, logger: noopLogger }, { cwd: CWD });
    const out = await leaf.execute(baseCtx({ expectedBranch: 'ralphctl/sprint-42' }));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.error.code).toBe('storage-error');
  });
});
