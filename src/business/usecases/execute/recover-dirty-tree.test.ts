import { describe, expect, it } from 'vitest';

import { StorageError } from '@src/domain/errors/storage-error.ts';
import { Result } from '@src/domain/result.ts';
import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import { SprintId } from '@src/domain/values/sprint-id.ts';
import { Slug } from '@src/domain/values/slug.ts';
import { FakeExternalPort } from '@src/business/_test-fakes/fake-external-port.ts';
import { FakeLoggerPort } from '@src/business/_test-fakes/fake-logger-port.ts';
import { RecoverDirtyTreeUseCase } from './recover-dirty-tree.ts';

function path(p: string): AbsolutePath {
  const r = AbsolutePath.parse(p);
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

function sprintId(): SprintId {
  const s = Slug.parse('demo');
  if (!s.ok) throw new Error('precondition failed');
  return SprintId.create(new Date('2026-04-29T14:15:22Z'), s.value);
}

describe('RecoverDirtyTreeUseCase', () => {
  it('does nothing when the working tree is clean', async () => {
    const external = new FakeExternalPort({ uncommitted: false });
    const uc = new RecoverDirtyTreeUseCase(external, new FakeLoggerPort());

    const result = await uc.execute({
      projectPath: path('/repos/demo'),
      taskName: 'add login',
      sprintId: sprintId(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.committed).toBe(false);
    expect(result.value.commitMessage).toBeUndefined();
    expect(external.autoCommitCalls).toHaveLength(0);
  });

  it('auto-commits when the tree is dirty', async () => {
    const external = new FakeExternalPort({
      uncommitted: true,
      autoCommitOutcomes: [Result.ok()],
    });
    const uc = new RecoverDirtyTreeUseCase(external, new FakeLoggerPort());

    const result = await uc.execute({
      projectPath: path('/repos/demo'),
      taskName: 'add login',
      sprintId: sprintId(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.committed).toBe(true);
    expect(result.value.commitMessage).toContain('add login');
    expect(external.autoCommitCalls).toHaveLength(1);
  });

  it('treats autoCommit failure as non-fatal (returns committed: false, no error)', async () => {
    const failure = new StorageError({
      subCode: 'io',
      message: 'pre-commit hook rejected the commit',
    });
    const external = new FakeExternalPort({
      uncommitted: true,
      autoCommitOutcomes: [Result.error(failure)],
    });
    const logger = new FakeLoggerPort();
    const uc = new RecoverDirtyTreeUseCase(external, logger);

    const result = await uc.execute({
      projectPath: path('/repos/demo'),
      taskName: 'add login',
      sprintId: sprintId(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.committed).toBe(false);
    expect(result.value.commitMessage).toBeDefined();
    expect(logger.hasMessage('error', 'auto-commit failed')).toBe(true);
  });

  it('includes the task name and sprint id in the commit message', async () => {
    const external = new FakeExternalPort({
      uncommitted: true,
      autoCommitOutcomes: [Result.ok()],
    });
    const id = sprintId();
    const uc = new RecoverDirtyTreeUseCase(external, new FakeLoggerPort());

    await uc.execute({
      projectPath: path('/repos/demo'),
      taskName: 'add login',
      sprintId: id,
    });

    const msg = external.autoCommitCalls[0]?.message ?? '';
    expect(msg).toContain('"add login"');
    expect(msg).toContain(id);
    expect(msg.startsWith('chore(harness):')).toBe(true);
  });

  it('treats a "no-changes" StorageError from autoCommit as a clean-tree no-op', async () => {
    // Defensive path: hasUncommittedChanges() was true at the start, but
    // by the time autoCommit() ran the tree had become clean (e.g. an
    // overlapping commit from another harness). The dedicated sub-code
    // lets us detect that without a brittle message-string match.
    const noChanges = new StorageError({ subCode: 'no-changes', message: 'no changes' });
    const external = new FakeExternalPort({
      uncommitted: true,
      autoCommitOutcomes: [Result.error(noChanges)],
    });
    const logger = new FakeLoggerPort();
    const uc = new RecoverDirtyTreeUseCase(external, logger);

    const result = await uc.execute({
      projectPath: path('/repos/demo'),
      taskName: 'add login',
      sprintId: sprintId(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.committed).toBe(false);
    expect(result.value.commitMessage).toBeUndefined();
    // Crucially, no error log: a clean tree is not a failure.
    expect(logger.hasMessage('error', 'auto-commit failed')).toBe(false);
  });

  it('logs a warning when the tree is dirty before committing', async () => {
    const logger = new FakeLoggerPort();
    const external = new FakeExternalPort({
      uncommitted: true,
      autoCommitOutcomes: [Result.ok()],
    });
    const uc = new RecoverDirtyTreeUseCase(external, logger);

    await uc.execute({
      projectPath: path('/repos/demo'),
      taskName: 'X',
      sprintId: sprintId(),
    });

    expect(logger.hasMessage('warn', 'dirty tree')).toBe(true);
  });
});
