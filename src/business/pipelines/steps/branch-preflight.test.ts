import { describe, it, expect, vi } from 'vitest';
import { StepError, StorageError } from '@src/domain/errors.ts';
import type { Sprint } from '@src/domain/models.ts';
import type { ExternalPort } from '@src/business/ports/external.ts';
import type { StepContext } from '@src/domain/context.ts';
import { branchPreflightStep } from './branch-preflight.ts';
import type { BranchPreflightContext } from './branch-preflight.ts';

interface Ctx extends StepContext, BranchPreflightContext {
  sprint?: Sprint;
}

function makeSprint(branch: string | null): Sprint {
  return {
    id: 's1',
    name: 'Sprint 1',
    status: 'active',
    createdAt: new Date().toISOString(),
    activatedAt: null,
    closedAt: null,
    tickets: [],
    checkRanAt: {},
    branch,
  };
}

function makeExternal(verifyBranch: ExternalPort['verifyBranch']): ExternalPort {
  return { verifyBranch } as unknown as ExternalPort;
}

describe('branchPreflightStep', () => {
  it('is a no-op when sprint.branch is null', async () => {
    const verify = vi.fn(() => false);
    const step = branchPreflightStep<Ctx>(makeExternal(verify));
    const result = await step.execute({
      sprintId: 's1',
      sprint: makeSprint(null),
      currentTaskProjectPath: '/a',
    });
    expect(result.ok).toBe(true);
    expect(verify).not.toHaveBeenCalled();
  });

  it('passes when verifyBranch returns true on first attempt', async () => {
    const verify = vi.fn(() => true);
    const step = branchPreflightStep<Ctx>(makeExternal(verify));
    const result = await step.execute({
      sprintId: 's1',
      sprint: makeSprint('feature/x'),
      currentTaskProjectPath: '/a',
    });
    expect(result.ok).toBe(true);
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it('retries up to maxRetries times before failing', async () => {
    const verify = vi.fn(() => false);
    const step = branchPreflightStep<Ctx>(makeExternal(verify), {
      maxRetries: 3,
      retryDelayMs: 1,
    });
    const result = await step.execute({
      sprintId: 's1',
      sprint: makeSprint('feature/x'),
      currentTaskProjectPath: '/a',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBeInstanceOf(StorageError);
    expect(verify).toHaveBeenCalledTimes(3);
  });

  it('succeeds after retrying if branch eventually matches', async () => {
    let call = 0;
    const verify = vi.fn(() => ++call === 3);
    const step = branchPreflightStep<Ctx>(makeExternal(verify), {
      maxRetries: 5,
      retryDelayMs: 1,
    });
    const result = await step.execute({
      sprintId: 's1',
      sprint: makeSprint('feature/x'),
      currentTaskProjectPath: '/a',
    });
    expect(result.ok).toBe(true);
    expect(verify).toHaveBeenCalledTimes(3);
  });

  it('returns StepError when ctx.sprint is missing', async () => {
    const step = branchPreflightStep<Ctx>(makeExternal(() => true));
    const result = await step.execute({ sprintId: 's1', currentTaskProjectPath: '/a' });
    expect(result.ok).toBe(false);
    expect(result.error).toBeInstanceOf(StepError);
  });

  it('returns StepError when currentTaskProjectPath is missing', async () => {
    const step = branchPreflightStep<Ctx>(makeExternal(() => true));
    const result = await step.execute({ sprintId: 's1', sprint: makeSprint('feature/x') });
    expect(result.ok).toBe(false);
    expect(result.error).toBeInstanceOf(StepError);
  });

  it('uses resolveProjectPath override when provided', async () => {
    const verify = vi.fn(() => true);
    const step = branchPreflightStep<Ctx>(makeExternal(verify), {
      resolveProjectPath: () => '/custom',
    });
    const result = await step.execute({
      sprintId: 's1',
      sprint: makeSprint('feature/x'),
    });
    expect(result.ok).toBe(true);
    expect(verify).toHaveBeenCalledWith('/custom', 'feature/x');
  });
});
