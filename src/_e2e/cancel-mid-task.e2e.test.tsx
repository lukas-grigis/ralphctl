/**
 * E2E scenario — task cancelled mid-spawn.
 *
 * One task whose AI spawn rejects with a kernel-shaped abort error. The
 * per-task chain's `OnError(catchIf: code === 'aborted')` catches it and
 * runs `markCancelledFallbackLeaf`. Verifies:
 *
 *   - the chain reaches a terminal state without crashing
 *   - the runner ends `completed` (the OnError fallback recovers)
 *   - the task is persisted as `blocked` with reason `"cancelled by user"`
 *   - the rendered frame shows the chain-level [COMPLETED] chip
 *
 * Honest limitation: this scenario uses the throw-AbortKernelError pattern
 * (same as `per-task-flow.test.ts:289`) rather than driving the abort via
 * `SessionManager.kill()`. Today `ExecuteSingleTaskUseCase` does NOT forward
 * the kernel's `AbortSignal` to the AI session — pressing the cancel key
 * mid-spawn relies on the provider's child-process SIGTERM path, not on
 * the kernel signal. Until the use case opts into the signal, an e2e that
 * hangs the spawn and calls `kill()` would deadlock. Tracked separately.
 */
import { describe, it, expect } from 'vitest';
import { Result } from '@src/domain/result.ts';

import { abs, makeApprovedTicket, makeSprint, makeTask } from '@src/application/_test-fakes/fixtures.ts';
import { StorageError } from '@src/domain/errors/storage-error.ts';
import type { AiSessionPort, SessionResult } from '@src/business/ports/ai-session-port.ts';
import type { DomainError } from '@src/domain/errors/domain-error.ts';
import { bootExecuteScenario } from './harness.tsx';

const CWD = abs('/tmp/e2e-cancel');

class AbortKernelError extends Error {
  readonly code = 'aborted';
  constructor() {
    super('cancelled by user');
    this.name = 'AbortKernelError';
  }
}

/** AiSession that rejects every spawn with an `aborted`-coded error. */
const abortingAiSession: AiSessionPort = {
  spawnHeadless(): Promise<Result<SessionResult, DomainError>> {
    return Promise.reject(new AbortKernelError());
  },
  spawnWithRetry(): Promise<Result<SessionResult, DomainError>> {
    return Promise.reject(new AbortKernelError());
  },
  spawnInteractive(): Promise<Result<void, DomainError>> {
    return Promise.resolve(Result.error(new StorageError({ subCode: 'io', message: 'unused' })));
  },
  resumeSession(): Promise<Result<SessionResult, DomainError>> {
    return Promise.reject(new AbortKernelError());
  },
  ensureReady(): Promise<void> {
    return Promise.resolve();
  },
  getProviderName: () => 'claude',
  getProviderDisplayName: () => 'Claude',
  getSpawnEnv: () => ({}),
};

describe('e2e: task cancelled mid-spawn', () => {
  it('marks the task blocked with reason "cancelled by user", chain settles cleanly', async () => {
    const sprint0 = makeSprint({ slug: 'cancel' });
    const ticket = makeApprovedTicket();
    const withTicket = sprint0.addTicket(ticket);
    if (!withTicket.ok) throw new Error('precondition: addTicket');
    const activated = withTicket.value.activate(sprint0.createdAt);
    if (!activated.ok) throw new Error('precondition: activate');
    const branched = activated.value.setBranch('ralphctl/cancel');
    if (!branched.ok) throw new Error('precondition: setBranch');
    const sprint = branched.value;

    const task = makeTask({ name: 'do-thing', order: 1, projectPath: '/tmp/cancel-repo' });

    const harness = bootExecuteScenario({
      sprint,
      sprintTasks: [task],
      cwd: CWD,
      evaluationIterations: 0,
      overrides: { aiSession: abortingAiSession },
    });

    // The chain resolves OK — markCancelledFallback recovers the abort.
    const terminal = await harness.waitForTerminal({ timeout: 6000 });
    expect(terminal).toBe('completed');

    // Task persisted as blocked with the canonical reason.
    const persisted = await harness.deps.taskRepo.findById(sprint.id, task.id);
    if (!persisted.ok) throw new Error('taskRepo.findById failed');
    expect(persisted.value.status).toBe('blocked');
    expect(persisted.value.blockedReason).toBe('cancelled by user');

    // Frame settles with the chain-level COMPLETED chip — the per-task
    // outcome is "blocked" but the chain itself recovered cleanly.
    await harness.waitForFrame(/COMPLETED/);
  });
});
