import { describe, expect, it } from 'vitest';

import { AbsolutePath } from '../../../domain/values/absolute-path.ts';
import { FakeExternalPort } from '../../_test-fakes/fake-external-port.ts';
import { FakeLoggerPort } from '../../_test-fakes/fake-logger-port.ts';
import { BranchPreflightUseCase } from './branch-preflight.ts';

function path(p: string): AbsolutePath {
  const r = AbsolutePath.parse(p);
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

describe('BranchPreflightUseCase', () => {
  it('returns ok when the repo is on the expected branch', async () => {
    const external = new FakeExternalPort({ branchOk: true });
    const uc = new BranchPreflightUseCase(external, new FakeLoggerPort());

    const result = await uc.execute({
      projectPath: path('/repos/demo'),
      expectedBranch: 'ralphctl/sprint-1',
    });

    expect(result.ok).toBe(true);
    expect(external.verifyBranchCalls).toHaveLength(1);
    expect(external.verifyBranchCalls[0]?.expected).toBe('ralphctl/sprint-1');
  });

  it('returns InvalidStateError when on a different branch', async () => {
    const external = new FakeExternalPort({
      branchOk: false,
      currentBranch: 'main',
    });
    const uc = new BranchPreflightUseCase(external, new FakeLoggerPort());

    const result = await uc.execute({
      projectPath: path('/repos/demo'),
      expectedBranch: 'ralphctl/sprint-1',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid-state');
      if (result.error.code === 'invalid-state') {
        expect(result.error.entity).toBe('repo');
        expect(result.error.currentState).toBe('main');
        expect(result.error.attemptedAction).toBe('execute-task');
      }
    }
  });

  it('reports unknown branch when getCurrentBranch returns an empty string', async () => {
    const external = new FakeExternalPort({
      branchOk: false,
      currentBranch: '',
    });
    const uc = new BranchPreflightUseCase(external, new FakeLoggerPort());

    const result = await uc.execute({
      projectPath: path('/repos/demo'),
      expectedBranch: 'ralphctl/sprint-1',
    });

    expect(result.ok).toBe(false);
    if (!result.ok && result.error.code === 'invalid-state') {
      expect(result.error.currentState).toBe('unknown');
    }
  });

  it('skips verification when expectedBranch is empty (no branch management)', async () => {
    const external = new FakeExternalPort({ branchOk: false });
    const uc = new BranchPreflightUseCase(external, new FakeLoggerPort());

    const result = await uc.execute({
      projectPath: path('/repos/demo'),
      expectedBranch: '',
    });

    expect(result.ok).toBe(true);
    expect(external.verifyBranchCalls).toHaveLength(0);
  });

  it('logs a warning on mismatch', async () => {
    const logger = new FakeLoggerPort();
    const external = new FakeExternalPort({
      branchOk: false,
      currentBranch: 'feature/x',
    });
    const uc = new BranchPreflightUseCase(external, logger);

    await uc.execute({
      projectPath: path('/repos/demo'),
      expectedBranch: 'ralphctl/sprint-1',
    });

    expect(logger.hasMessage('warn', 'branch-preflight mismatch')).toBe(true);
  });
});
