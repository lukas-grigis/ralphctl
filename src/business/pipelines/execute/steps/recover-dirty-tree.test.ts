import { describe, expect, it, vi } from 'vitest';
import type { Sprint, Task } from '@src/domain/models.ts';
import type { PersistencePort } from '@src/business/ports/persistence.ts';
import type { ExternalPort } from '@src/business/ports/external.ts';
import type { LoggerPort, SpinnerHandle } from '@src/business/ports/logger.ts';
import type { SignalBusPort } from '@src/business/ports/signal-bus.ts';
import { recoverDirtyTree } from './recover-dirty-tree.ts';
import type { PerTaskContext } from '../per-task-context.ts';

// Behavioural coverage lives in `src/business/usecases/recover-dirty-tree.test.ts`.
// This file only verifies the pipeline-step wiring: resolve the repo path from
// `task.repoId` and forward to the helper.

function makeSprint(): Sprint {
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
    branch: null,
  };
}

function makeTask(): Task {
  return {
    id: 't1',
    name: 'Task 1',
    steps: [],
    verificationCriteria: [],
    status: 'in_progress',
    order: 1,
    blockedBy: [],
    repoId: 'repo-1',
    verified: false,
    evaluated: false,
  };
}

function makeSpinner(): SpinnerHandle {
  return { succeed: () => undefined, fail: () => undefined, stop: () => undefined };
}

describe('recoverDirtyTree step (wiring)', () => {
  it('resolves repo path from task.repoId and forwards to the helper', async () => {
    const resolveRepoPath = vi.fn(() => Promise.resolve('/resolved/repo'));
    const hasUncommittedChanges = vi.fn(() => true);
    const autoCommit = vi.fn(() => Promise.resolve());

    const logger: LoggerPort = {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      success: () => undefined,
      warning: () => undefined,
      tip: () => undefined,
      header: () => undefined,
      separator: () => undefined,
      field: () => undefined,
      card: () => undefined,
      newline: () => undefined,
      dim: () => undefined,
      item: () => undefined,
      spinner: () => makeSpinner(),
      child: () => logger,
      time: () => () => undefined,
    };

    const deps = {
      persistence: { resolveRepoPath } as unknown as PersistencePort,
      external: { hasUncommittedChanges, autoCommit } as unknown as ExternalPort,
      logger,
      signalBus: { emit: () => undefined, subscribe: () => () => undefined, dispose: () => undefined } as SignalBusPort,
    };

    const ctx: PerTaskContext = { sprintId: 's1', sprint: makeSprint(), task: makeTask() };
    const result = await recoverDirtyTree(deps).execute(ctx);

    expect(result.ok).toBe(true);
    expect(resolveRepoPath).toHaveBeenCalledWith('repo-1');
    expect(hasUncommittedChanges).toHaveBeenCalledWith('/resolved/repo');
    expect(autoCommit).toHaveBeenCalledWith(
      '/resolved/repo',
      'chore(harness): auto-commit leftover changes from "Task 1"'
    );
  });
});
