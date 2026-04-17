import { describe, it, expect, vi } from 'vitest';
import { BranchPreflightError } from '@src/domain/errors.ts';
import type { Sprint, Task } from '@src/domain/models.ts';
import type { ExternalPort } from '@src/business/ports/external.ts';
import { branchPreflight } from './branch-preflight.ts';
import type { PerTaskContext } from '../per-task-context.ts';

function makeSprint(branch: string | null): Sprint {
  return {
    id: 's1',
    name: 'Sprint',
    status: 'active',
    createdAt: '',
    activatedAt: null,
    closedAt: null,
    tickets: [],
    checkRanAt: {},
    branch,
  };
}

function makeTask(projectPath = '/repo/a'): Task {
  return {
    id: 't1',
    name: 'Task 1',
    steps: [],
    verificationCriteria: [],
    status: 'todo',
    order: 1,
    blockedBy: [],
    projectPath,
    verified: false,
    evaluated: false,
  };
}

function makeCtx(sprint: Sprint, task: Task): PerTaskContext {
  return { sprintId: sprint.id, sprint, task };
}

function makeExternal(verify: ExternalPort['verifyBranch']): ExternalPort {
  return { verifyBranch: verify } as unknown as ExternalPort;
}

describe('branchPreflight step', () => {
  it('no-ops when sprint.branch is null', async () => {
    const verify = vi.fn(() => false);
    const result = await branchPreflight({ external: makeExternal(verify) }).execute(
      makeCtx(makeSprint(null), makeTask())
    );
    expect(result.ok).toBe(true);
    expect(verify).not.toHaveBeenCalled();
  });

  it('passes when verifyBranch returns true', async () => {
    const verify = vi.fn(() => true);
    const result = await branchPreflight({ external: makeExternal(verify) }).execute(
      makeCtx(makeSprint('feature/x'), makeTask('/repo/a'))
    );
    expect(result.ok).toBe(true);
    expect(verify).toHaveBeenCalledWith('/repo/a', 'feature/x');
  });

  it('returns BranchPreflightError on first mismatch (no inner retry)', async () => {
    const verify = vi.fn(() => false);
    const result = await branchPreflight({ external: makeExternal(verify) }).execute(
      makeCtx(makeSprint('feature/x'), makeTask('/repo/a'))
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(BranchPreflightError);
    if (result.error instanceof BranchPreflightError) {
      expect(result.error.projectPath).toBe('/repo/a');
      expect(result.error.expectedBranch).toBe('feature/x');
    }
    expect(verify).toHaveBeenCalledTimes(1);
  });
});
