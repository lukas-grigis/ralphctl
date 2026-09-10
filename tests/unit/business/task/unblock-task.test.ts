import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { unblockTaskUseCase } from '@src/business/task/unblock-task.ts';
import { foldTaskRollup } from '@src/business/runs/outcome-stats.ts';
import type { BlockedTask, Task } from '@src/domain/entity/task.ts';
import { BLOCKED_UPSTREAM_REASON_PREFIX, markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';
import { recordTaskEscalation } from '@src/domain/entity/task-settle.ts';
import { recordRunningAttemptWarning } from '@src/domain/entity/task-attempts.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { UpdateTask } from '@src/domain/repository/task/update-task.ts';
import type { FindTasksBySprintId } from '@src/domain/repository/task/find-tasks-by-sprint-id.ts';
import type { SaveAllTasks } from '@src/domain/repository/task/save-all-tasks.ts';
import type { FindById } from '@src/domain/repository/_base/find-by-id.ts';
import type { Save } from '@src/domain/repository/_base/save.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import {
  FIXED_LATEST,
  makeActiveSprint,
  makeDoneSprint,
  makeDoneTask,
  makeInProgressTaskWithRunningAttempt,
  makeReviewSprint,
  makeTodoTask,
} from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';

const SPRINT_ID = '01900000-0000-7000-8000-0000000000aa' as unknown as SprintId;

const FIXED_CLOCK = (): IsoTimestamp => FIXED_LATEST;

type SprintRepo = FindById<Sprint, SprintId> & Save<Sprint>;
interface SprintRepoDouble {
  readonly repo: SprintRepo;
  /** The sprint handed to the most recent `save()` call, or undefined if reopen never persisted. */
  readonly saved: () => Sprint | undefined;
  /** Every sprint handed to `save()`, in call order — lets a test assert a two-hop reopen. */
  readonly savedHistory: () => readonly Sprint[];
}

// Sprint repo double: `findById` returns the seeded sprint, `save` records it. Default seed is an
// ACTIVE sprint, so the reopen-on-unblock path is a no-op unless a test seeds a `review` sprint.
const sprintRepoWith = (sprint: Sprint = makeActiveSprint()): SprintRepoDouble => {
  const history: Sprint[] = [];
  const repo: SprintRepo = {
    async findById() {
      return Result.ok(sprint);
    },
    async save(s) {
      history.push(s);
      return Result.ok(undefined);
    },
  };
  return { repo, saved: () => history.at(-1), savedHistory: () => history };
};

const makeBlockedTask = (reason = 'flaky pre-task verify'): BlockedTask => {
  const r = markTaskBlocked(makeTodoTask(), reason, 'own');
  if (!r.ok) throw new Error(`fixture: ${r.error.message}`);
  return r.value;
};

type Repo = UpdateTask & FindTasksBySprintId & SaveAllTasks;
interface RepoDouble {
  readonly repo: Repo;
  /** Tasks handed to the most recent persistence call (saveAll list, or a single update). */
  readonly saved: () => readonly Task[];
}

// Seeds the sprint's task list for findBySprintId and records whatever the use case persists.
const repoOk = (seed: readonly Task[] = []): RepoDouble => {
  let saved: Task[] = [];
  const repo: Repo = {
    async update(_sprintId, task) {
      saved = [task];
      return Result.ok(undefined);
    },
    async findBySprintId() {
      return Result.ok(seed);
    },
    async saveAll(_sprintId, tasks) {
      saved = [...tasks];
      return Result.ok(undefined);
    },
  };
  return { repo, saved: () => saved };
};

// Persistence fails on the saveAll path (the cascade write).
const repoFailing = (seed: readonly Task[] = []): Repo => ({
  async update() {
    return Result.error(new StorageError({ subCode: 'io', message: 'disk full', path: 'tasks' }));
  },
  async findBySprintId() {
    return Result.ok(seed);
  },
  async saveAll() {
    return Result.error(new StorageError({ subCode: 'io', message: 'disk full', path: 'tasks' }));
  },
});

describe('unblockTaskUseCase', () => {
  it('transitions blocked → todo, strips blockedReason, and persists', async () => {
    const blocked = makeBlockedTask('mvn agent attach failed');
    const repo = repoOk([blocked]);

    const result = await unblockTaskUseCase({
      task: blocked,
      sprintId: SPRINT_ID,
      taskRepo: repo.repo,
      sprintRepo: sprintRepoWith().repo,
      clock: FIXED_CLOCK,
      logger: noopLogger,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('todo');
    expect((result.value as unknown as { blockedReason?: string }).blockedReason).toBeUndefined();
    expect(repo.saved()).toHaveLength(1);
    expect(repo.saved()[0]?.status).toBe('todo');
  });

  it('archives the retired attempts + escalation stamp instead of deleting them', async () => {
    const inProgress = makeInProgressTaskWithRunningAttempt();
    const escalated = recordTaskEscalation(inProgress, 'claude-sonnet-4-6', 'claude-opus-4-8');
    if (!escalated.ok) throw escalated.error;
    const blocked = markTaskBlocked(escalated.value, 'attempt budget exhausted', 'own');
    if (!blocked.ok) throw blocked.error;
    const repo = repoOk([blocked.value]);

    const result = await unblockTaskUseCase({
      task: blocked.value,
      sprintId: SPRINT_ID,
      taskRepo: repo.repo,
      sprintRepo: sprintRepoWith().repo,
      clock: FIXED_CLOCK,
      logger: noopLogger,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Live budget resets...
    expect(result.value.attempts).toHaveLength(0);
    // ...but the persisted result — what actually lands in tasks.json — still carries the forensic
    // record instead of the operator's intervention silently erasing it.
    const persisted = repo.saved()[0];
    const archive = (persisted as unknown as { retiredAttempts?: readonly unknown[] }).retiredAttempts;
    expect(archive).toHaveLength(1);
    expect((archive?.[0] as { attempts: readonly unknown[] }).attempts).toHaveLength(1);
    expect((archive?.[0] as { escalatedToModel?: string }).escalatedToModel).toBe('claude-opus-4-8');
  });

  it('an archived attempt still counts in foldTaskRollup after unblock — no signal is lost', async () => {
    // The exact bug this workstream fixes: before archiving, `unblockTask` wiped `attempts` back to
    // `[]`, so a plateau warning that justified the block would silently vanish from the outcome
    // report the moment the operator intervened.
    const inProgress = makeInProgressTaskWithRunningAttempt();
    const warned = recordRunningAttemptWarning(inProgress, { kind: 'plateau', dimensions: ['C1'] });
    if (!warned.ok) throw warned.error;
    const blocked = markTaskBlocked(warned.value, 'plateaued repeatedly', 'own');
    if (!blocked.ok) throw blocked.error;
    const repo = repoOk([blocked.value]);

    const result = await unblockTaskUseCase({
      task: blocked.value,
      sprintId: SPRINT_ID,
      taskRepo: repo.repo,
      sprintRepo: sprintRepoWith().repo,
      clock: FIXED_CLOCK,
      logger: noopLogger,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.attempts).toHaveLength(0); // live ledger really is reset

    const persisted = repo.saved()[0];
    if (persisted === undefined) throw new Error('expected a persisted task');
    const rollup = foldTaskRollup([persisted]);
    expect(rollup.attemptCount).toBe(1);
    expect(rollup.plateau.attemptsWithPlateau).toBe(1);
    expect(rollup.warnings.byKind.plateau).toBe(1);
  });

  it('idempotent — already-todo passes through without re-saving', async () => {
    const todo = makeTodoTask();
    const repo = repoOk([todo]);

    const result = await unblockTaskUseCase({
      task: todo,
      sprintId: SPRINT_ID,
      taskRepo: repo.repo,
      sprintRepo: sprintRepoWith().repo,
      clock: FIXED_CLOCK,
      logger: noopLogger,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('todo');
    expect(repo.saved()).toHaveLength(0);
  });

  it('rejects an in_progress task with InvalidStateError', async () => {
    const inProgress = makeInProgressTaskWithRunningAttempt();
    const repo = repoOk([inProgress]);

    const result = await unblockTaskUseCase({
      task: inProgress,
      sprintId: SPRINT_ID,
      taskRepo: repo.repo,
      sprintRepo: sprintRepoWith().repo,
      clock: FIXED_CLOCK,
      logger: noopLogger,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid-state');
    expect(repo.saved()).toHaveLength(0);
  });

  it('rejects a done task with InvalidStateError', async () => {
    const done = makeDoneTask();
    const repo = repoOk([done]);

    const result = await unblockTaskUseCase({
      task: done,
      sprintId: SPRINT_ID,
      taskRepo: repo.repo,
      sprintRepo: sprintRepoWith().repo,
      clock: FIXED_CLOCK,
      logger: noopLogger,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid-state');
    expect(repo.saved()).toHaveLength(0);
  });

  it('propagates StorageError when persistence fails', async () => {
    const blocked = makeBlockedTask();

    const result = await unblockTaskUseCase({
      task: blocked,
      sprintId: SPRINT_ID,
      taskRepo: repoFailing([blocked]),
      sprintRepo: sprintRepoWith().repo,
      clock: FIXED_CLOCK,
      logger: noopLogger,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('storage-error');
  });

  it('cascade-unblocks upstream-blocked dependents when the root is unblocked', async () => {
    const root = makeBlockedTask('own failure: eval did not pass'); // own-failure block on the root
    const depTodo = makeTodoTask({ name: 'dependent', dependsOn: [root.id] });
    const depUpstream = markTaskBlocked(
      depTodo,
      `${BLOCKED_UPSTREAM_REASON_PREFIX} — prerequisite not done: root`,
      'upstream'
    );
    if (!depUpstream.ok) throw depUpstream.error;
    const repo = repoOk([root, depUpstream.value]);

    const result = await unblockTaskUseCase({
      task: root,
      sprintId: SPRINT_ID,
      taskRepo: repo.repo,
      sprintRepo: sprintRepoWith().repo,
      clock: FIXED_CLOCK,
      logger: noopLogger,
    });

    expect(result.ok).toBe(true);
    const saved = repo.saved();
    expect(saved.find((t) => t.id === root.id)?.status).toBe('todo');
    // The dependent the dependency gate parked is re-armed in the same transaction.
    expect(saved.find((t) => t.id === depUpstream.value.id)?.status).toBe('todo');
  });

  it('does NOT cascade-unblock a dependent blocked for its own failure', async () => {
    const root = makeBlockedTask('root own failure');
    const depTodo = makeTodoTask({ name: 'dependent', dependsOn: [root.id] });
    const depOwn = markTaskBlocked(depTodo, 'verify failed on the dependent itself', 'own'); // NOT an upstream prefix
    if (!depOwn.ok) throw depOwn.error;
    const repo = repoOk([root, depOwn.value]);

    const result = await unblockTaskUseCase({
      task: root,
      sprintId: SPRINT_ID,
      taskRepo: repo.repo,
      sprintRepo: sprintRepoWith().repo,
      clock: FIXED_CLOCK,
      logger: noopLogger,
    });

    expect(result.ok).toBe(true);
    const saved = repo.saved();
    expect(saved.find((t) => t.id === root.id)?.status).toBe('todo');
    // The dependent failed on its own merits — it is NOT in the cascade, so it is left untouched
    // on disk (only the primary is re-persisted). It stays blocked for the operator to fix.
    expect(saved.find((t) => t.id === depOwn.value.id)).toBeUndefined();
  });

  it('reopens a review sprint to active so the implement gate re-arms', async () => {
    const blocked = makeBlockedTask();
    const taskRepo = repoOk([blocked]);
    const sprintRepo = sprintRepoWith(makeReviewSprint());

    const result = await unblockTaskUseCase({
      task: blocked,
      sprintId: SPRINT_ID,
      taskRepo: taskRepo.repo,
      sprintRepo: sprintRepo.repo,
      clock: FIXED_CLOCK,
      logger: noopLogger,
    });

    expect(result.ok).toBe(true);
    const saved = sprintRepo.saved();
    expect(saved?.status).toBe('active');
    expect(saved?.reviewAt).toBeNull();
  });

  it('leaves a non-review sprint untouched (active passes through, no save)', async () => {
    const blocked = makeBlockedTask();
    const taskRepo = repoOk([blocked]);
    const sprintRepo = sprintRepoWith(makeActiveSprint());

    const result = await unblockTaskUseCase({
      task: blocked,
      sprintId: SPRINT_ID,
      taskRepo: taskRepo.repo,
      sprintRepo: sprintRepo.repo,
      clock: FIXED_CLOCK,
      logger: noopLogger,
    });

    expect(result.ok).toBe(true);
    expect(sprintRepo.saved()).toBeUndefined();
  });

  it('reopens the review sprint on the cascade path too', async () => {
    const root = makeBlockedTask('own failure: eval did not pass');
    const depTodo = makeTodoTask({ name: 'dependent', dependsOn: [root.id] });
    const depUpstream = markTaskBlocked(
      depTodo,
      `${BLOCKED_UPSTREAM_REASON_PREFIX} — prerequisite not done: root`,
      'upstream'
    );
    if (!depUpstream.ok) throw depUpstream.error;
    const taskRepo = repoOk([root, depUpstream.value]);
    const sprintRepo = sprintRepoWith(makeReviewSprint());

    const result = await unblockTaskUseCase({
      task: root,
      sprintId: SPRINT_ID,
      taskRepo: taskRepo.repo,
      sprintRepo: sprintRepo.repo,
      clock: FIXED_CLOCK,
      logger: noopLogger,
    });

    expect(result.ok).toBe(true);
    expect(sprintRepo.saved()?.status).toBe('active');
  });

  it('reopens a review sprint even when the task is already todo (recovery retry)', async () => {
    const todo = makeTodoTask();
    const taskRepo = repoOk([todo]);
    const sprintRepo = sprintRepoWith(makeReviewSprint());

    const result = await unblockTaskUseCase({
      task: todo,
      sprintId: SPRINT_ID,
      taskRepo: taskRepo.repo,
      sprintRepo: sprintRepo.repo,
      clock: FIXED_CLOCK,
      logger: noopLogger,
    });

    expect(result.ok).toBe(true);
    expect(sprintRepo.saved()?.status).toBe('active');
  });

  it('reopens a done sprint all the way to active — closed-and-blocked work becomes runnable again', async () => {
    const blocked = makeBlockedTask();
    const taskRepo = repoOk([blocked]);
    const sprintRepo = sprintRepoWith(makeDoneSprint());

    const result = await unblockTaskUseCase({
      task: blocked,
      sprintId: SPRINT_ID,
      taskRepo: taskRepo.repo,
      sprintRepo: sprintRepo.repo,
      clock: FIXED_CLOCK,
      logger: noopLogger,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('todo'); // the task itself is revived either way
    // The sprint hops done → review → active in the same unblock call, re-using the existing
    // review → active step rather than a parallel done → active transition — both saves land.
    const history = sprintRepo.savedHistory();
    expect(history.map((s) => s.status)).toEqual(['review', 'active']);
    expect(sprintRepo.saved()?.status).toBe('active');
    expect(sprintRepo.saved()?.doneAt).toBeNull();
  });

  it('best-effort — unblock still succeeds when a done sprint fails to reopen to review', async () => {
    const blocked = makeBlockedTask();
    const taskRepo = repoOk([blocked]);
    const doneSprint = makeDoneSprint();
    const sprintRepo: SprintRepo = {
      async findById() {
        return Result.ok(doneSprint);
      },
      async save() {
        return Result.error(new StorageError({ subCode: 'io', message: 'disk full', path: 'sprint' }));
      },
    };

    const result = await unblockTaskUseCase({
      task: blocked,
      sprintId: SPRINT_ID,
      taskRepo: taskRepo.repo,
      sprintRepo,
      clock: FIXED_CLOCK,
      logger: noopLogger,
    });

    // The task is already revived — a failed done → review hop must not roll that back, and the
    // review → active hop never even attempts against a sprint still stuck at 'done'.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('todo');
  });

  it('best-effort reopen — unblock still succeeds when the sprint save fails', async () => {
    const blocked = makeBlockedTask();
    const taskRepo = repoOk([blocked]);
    const reviewSprint = makeReviewSprint();
    const sprintRepo: SprintRepo = {
      async findById() {
        return Result.ok(reviewSprint);
      },
      async save() {
        return Result.error(new StorageError({ subCode: 'io', message: 'disk full', path: 'sprint' }));
      },
    };

    const result = await unblockTaskUseCase({
      task: blocked,
      sprintId: SPRINT_ID,
      taskRepo: taskRepo.repo,
      sprintRepo,
      clock: FIXED_CLOCK,
      logger: noopLogger,
    });

    // The task was already revived to todo before the reopen ran — a failed reopen must not roll
    // that back or surface as an error. The operator can re-run unblock to retry the reopen.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('todo');
  });
});
