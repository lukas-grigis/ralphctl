import { describe, expect, it, vi } from 'vitest';
import { BranchPreflightError } from '@src/domain/errors.ts';
import type { Sprint, Task } from '@src/domain/models.ts';
import type { ExternalPort } from '@src/business/ports/external.ts';
import type { PersistencePort } from '@src/business/ports/persistence.ts';
import { branchPreflight } from './branch-preflight.ts';
import type { PerTaskContext } from '../per-task-context.ts';

function makeSprint(branch: string | null): Sprint {
  return {
    id: 's1',
    name: 'Sprint',
    projectId: 'proj-1',
    status: 'active',
    createdAt: '',
    activatedAt: null,
    closedAt: null,
    tickets: [],
    checkRanAt: {},
    branch,
  };
}

function makeTask(repoId = 'repo-a'): Task {
  return {
    id: 't1',
    name: 'Task 1',
    steps: [],
    verificationCriteria: [],
    status: 'todo',
    order: 1,
    blockedBy: [],
    repoId,
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

function makePersistence(pathByRepoId: Record<string, string>): PersistencePort {
  return {
    resolveRepoPath: (id: string) => {
      const p = pathByRepoId[id];
      if (!p) return Promise.reject(new Error(`unknown repo: ${id}`));
      return Promise.resolve(p);
    },
  } as unknown as PersistencePort;
}

describe('branchPreflight step', () => {
  it('no-ops when sprint.branch is null', async () => {
    const verify = vi.fn(() => false);
    const result = await branchPreflight({
      external: makeExternal(verify),
      persistence: makePersistence({ 'repo-a': '/repo/a' }),
    }).execute(makeCtx(makeSprint(null), makeTask()));
    expect(result.ok).toBe(true);
    expect(verify).not.toHaveBeenCalled();
  });

  it('passes when verifyBranch returns true', async () => {
    const verify = vi.fn(() => true);
    const result = await branchPreflight({
      external: makeExternal(verify),
      persistence: makePersistence({ 'repo-a': '/repo/a' }),
    }).execute(makeCtx(makeSprint('feature/x'), makeTask('repo-a')));
    expect(result.ok).toBe(true);
    expect(verify).toHaveBeenCalledWith('/repo/a', 'feature/x');
  });

  it('returns BranchPreflightError on first mismatch (no inner retry)', async () => {
    const verify = vi.fn(() => false);
    const result = await branchPreflight({
      external: makeExternal(verify),
      persistence: makePersistence({ 'repo-a': '/repo/a' }),
    }).execute(makeCtx(makeSprint('feature/x'), makeTask('repo-a')));
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
