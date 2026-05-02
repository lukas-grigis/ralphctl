import { describe, expect, it } from 'vitest';

import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import { FakeExternalPort } from '@src/business/_test-fakes/fake-external-port.ts';
import { FakeLoggerPort } from '@src/business/_test-fakes/fake-logger-port.ts';
import { FakePromptPort } from '@src/application/_test-fakes/fake-prompt-port.ts';
import { DirtyTreePreflightUseCase } from './dirty-tree-preflight.ts';

function path(p: string): AbsolutePath {
  const r = AbsolutePath.parse(p);
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

describe('DirtyTreePreflightUseCase', () => {
  it('returns clean when no repo has uncommitted changes', async () => {
    const external = new FakeExternalPort({ uncommitted: false });
    const prompt = new FakePromptPort();
    const uc = new DirtyTreePreflightUseCase(external, prompt, new FakeLoggerPort());

    const result = await uc.execute({
      repoPaths: [path('/repos/a'), path('/repos/b')],
      stashMessage: 'ralphctl test',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outcome).toBe('clean');
    expect(result.value.dirtyRepos).toHaveLength(0);
    expect(prompt.selectMock).not.toHaveBeenCalled();
  });

  it('stashes every dirty repo when user picks "stash"', async () => {
    const external = new FakeExternalPort({ uncommitted: true });
    const prompt = new FakePromptPort();
    prompt.queueSelect('stash');
    const uc = new DirtyTreePreflightUseCase(external, prompt, new FakeLoggerPort());

    const result = await uc.execute({
      repoPaths: [path('/repos/a'), path('/repos/b')],
      stashMessage: 'ralphctl 20260429-x',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outcome).toBe('stashed');
    expect(external.stashCalls).toHaveLength(2);
    expect(external.stashCalls[0]?.message).toBe('ralphctl 20260429-x');
    expect(external.hardResetCalls).toHaveLength(0);
  });

  it('hard-resets every dirty repo when user picks "reset" and confirms', async () => {
    const external = new FakeExternalPort({ uncommitted: true });
    const prompt = new FakePromptPort();
    prompt.queueSelect('reset');
    prompt.queueConfirm(true);
    const uc = new DirtyTreePreflightUseCase(external, prompt, new FakeLoggerPort());

    const result = await uc.execute({
      repoPaths: [path('/repos/a')],
      stashMessage: 'unused',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outcome).toBe('reset');
    expect(external.hardResetCalls).toStrictEqual([path('/repos/a')]);
    expect(external.stashCalls).toHaveLength(0);
  });

  it('cancels when user declines the destructive reset confirm', async () => {
    const external = new FakeExternalPort({ uncommitted: true });
    const prompt = new FakePromptPort();
    prompt.queueSelect('reset');
    prompt.queueConfirm(false);
    const uc = new DirtyTreePreflightUseCase(external, prompt, new FakeLoggerPort());

    const result = await uc.execute({
      repoPaths: [path('/repos/a')],
      stashMessage: 'unused',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outcome).toBe('cancelled');
    expect(external.hardResetCalls).toHaveLength(0);
  });

  it('continues with dirty tree when user picks "continue"', async () => {
    const external = new FakeExternalPort({ uncommitted: true });
    const prompt = new FakePromptPort();
    prompt.queueSelect('continue');
    const uc = new DirtyTreePreflightUseCase(external, prompt, new FakeLoggerPort());

    const result = await uc.execute({
      repoPaths: [path('/repos/a')],
      stashMessage: 'unused',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outcome).toBe('continued');
    expect(external.stashCalls).toHaveLength(0);
    expect(external.hardResetCalls).toHaveLength(0);
  });

  it('cancels when user picks "cancel"', async () => {
    const external = new FakeExternalPort({ uncommitted: true });
    const prompt = new FakePromptPort();
    prompt.queueSelect('cancel');
    const uc = new DirtyTreePreflightUseCase(external, prompt, new FakeLoggerPort());

    const result = await uc.execute({
      repoPaths: [path('/repos/a')],
      stashMessage: 'unused',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outcome).toBe('cancelled');
    expect(external.stashCalls).toHaveLength(0);
    expect(external.hardResetCalls).toHaveLength(0);
  });
});
