import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
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
import type { ListAll } from '@src/domain/repository/_base/list-all.ts';
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
  projectId,
} from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';

const SPRINT_ID = '01900000-0000-7000-8000-0000000000aa' as unknown as SprintId;

const FIXED_CLOCK = (): IsoTimestamp => FIXED_LATEST;

type SprintRepo = FindById<Sprint, SprintId> & Save<Sprint> & ListAll<Sprint>;
interface SprintRepoDouble {
  readonly repo: SprintRepo;
  /** The sprint handed to the most recent `save()` call, or undefined if reopen never persisted. */
  readonly saved: () => Sprint | undefined;
  /** Every sprint handed to `save()`, in call order — lets a test assert a two-hop reopen. */
  readonly savedHistory: () => readonly Sprint[];
}

// Sprint repo double: `findById` returns the seeded sprint, `save` records it, and `list` answers
// the single-active-per-project peer check the `done` → `review` hop runs. Default seed is an
// ACTIVE sprint, so the reopen-on-unblock path is a no-op unless a test seeds a `review` / `done`
// one; `peers` defaults to the seeded sprint alone, which trivially satisfies the peer check.
const sprintRepoWith = (sprint: Sprint = makeActiveSprint(), peers?: readonly Sprint[]): SprintRepoDouble => {
  const history: Sprint[] = [];
  const repo: SprintRepo = {
    async findById() {
      return Result.ok(sprint);
    },
    async save(s) {
      history.push(s);
      return Result.ok(undefined);
    },
    async list() {
      return Result.ok(peers ?? [sprint]);
    },
  };
  return { repo, saved: () => history.at(-1), savedHistory: () => history };
};

/** Captures `warn` lines so a test can assert WHICH operation a refusal names. */
const warnRecordingLogger = (): { logger: Logger; warnings: readonly string[] } => {
  const warnings: string[] = [];
  const logger: Logger = {
    debug() {},
    info() {},
    warn(message) {
      warnings.push(message);
    },
    error() {},
    named() {
      return logger;
    },
  };
  return { logger, warnings };
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
    expect(result.value.task.status).toBe('todo');
    expect((result.value.task as unknown as { blockedReason?: string }).blockedReason).toBeUndefined();
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
    expect(result.value.task.attempts).toHaveLength(0);
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
    expect(result.value.task.attempts).toHaveLength(0); // live ledger really is reset

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
    expect(result.value.task.status).toBe('todo');
    expect(repo.saved()).toHaveLength(0);
    expect(result.value.sprintReopened).toBeUndefined();
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
    if (!result.ok) return;
    expect(result.value.sprintReopened?.from).toBe('review');
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
    if (!result.ok) return;
    expect(result.value.sprintReopened).toBeUndefined();
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
    if (!result.ok) return;
    expect(result.value.sprintReopened?.from).toBe('review');
    expect(result.value.sprintReopened?.sprint.status).toBe('active');
  });

  // Closing a sprint with `todo` work left is a legitimate descope. An unblock that revives
  // nothing (a wrong id, a scripted retry) has no business undoing that close.
  it('leaves a done sprint closed when the task is already todo — nothing was revived', async () => {
    const todo = makeTodoTask();
    const taskRepo = repoOk([todo]);
    const sprintRepo = sprintRepoWith(makeDoneSprint());

    const result = await unblockTaskUseCase({
      task: todo,
      sprintId: SPRINT_ID,
      taskRepo: taskRepo.repo,
      sprintRepo: sprintRepo.repo,
      clock: FIXED_CLOCK,
      logger: noopLogger,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.task.status).toBe('todo');
    expect(sprintRepo.savedHistory()).toHaveLength(0);
    expect(result.value.sprintReopened).toBeUndefined();
    expect(result.value.sprintReopenConflict).toBeUndefined();
  });

  // Crash safety for the done hop: it lands BEFORE the task write, so a process that dies between
  // the two leaves a `review` sprint with the task still blocked (the same state a mixed run
  // settles to) and a retry walks the full path again. The reverse order would leave `todo` work
  // behind a `done` sprint, which the already-todo leg above deliberately refuses to reopen.
  it('carries a done sprint to review before persisting the revived task', async () => {
    const blocked = makeBlockedTask();
    const calls: string[] = [];
    const doneSprint = makeDoneSprint();
    const taskRepo: Repo = {
      async update() {
        calls.push('task');
        return Result.ok(undefined);
      },
      async findBySprintId() {
        return Result.ok([blocked]);
      },
      async saveAll() {
        calls.push('task');
        return Result.ok(undefined);
      },
    };
    const sprintRepo: SprintRepo = {
      async findById() {
        return Result.ok(doneSprint);
      },
      async save(s) {
        calls.push(`sprint:${s.status}`);
        return Result.ok(undefined);
      },
      async list() {
        return Result.ok([doneSprint]);
      },
    };

    const result = await unblockTaskUseCase({
      task: blocked,
      sprintId: SPRINT_ID,
      taskRepo,
      sprintRepo,
      clock: FIXED_CLOCK,
      logger: noopLogger,
    });

    expect(result.ok).toBe(true);
    expect(calls).toEqual(['sprint:review', 'task', 'sprint:active']);
  });

  it('puts a closed sprint back when the task write fails after the done → review hop', async () => {
    const blocked = makeBlockedTask();
    const doneSprint = makeDoneSprint();
    const sprintRepo = sprintRepoWith(doneSprint);

    const result = await unblockTaskUseCase({
      task: blocked,
      sprintId: SPRINT_ID,
      taskRepo: repoFailing([blocked]),
      sprintRepo: sprintRepo.repo,
      clock: FIXED_CLOCK,
      logger: noopLogger,
    });

    // A failed unblock must not leave the operator's closed sprint sitting in `review`, holding
    // the project, with nothing revived.
    expect(result.ok).toBe(false);
    expect(sprintRepo.savedHistory().map((s) => s.status)).toEqual(['review', 'done']);
    expect(sprintRepo.saved()).toBe(doneSprint);
  });

  it('reports done → review when only the review → active step fails, and a retry finishes it', async () => {
    const blocked = makeBlockedTask();
    const taskRepo = repoOk([blocked]);
    let current: Sprint = makeDoneSprint();
    let saves = 0;
    const sprintRepo: SprintRepo = {
      async findById() {
        return Result.ok(current);
      },
      async save(s) {
        saves += 1;
        if (saves === 2) return Result.error(new StorageError({ subCode: 'io', message: 'disk full', path: 'sprint' }));
        current = s;
        return Result.ok(undefined);
      },
      async list() {
        return Result.ok([current]);
      },
    };

    const first = await unblockTaskUseCase({
      task: blocked,
      sprintId: SPRINT_ID,
      taskRepo: taskRepo.repo,
      sprintRepo,
      clock: FIXED_CLOCK,
      logger: noopLogger,
    });

    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(current.status).toBe('review');
    expect(first.value.sprintReopened?.from).toBe('done');
    expect(first.value.sprintReopened?.sprint.status).toBe('review');

    // The retry sees the revived `todo` task on a `review` sprint and completes the reopen.
    const retry = await unblockTaskUseCase({
      task: first.value.task,
      sprintId: SPRINT_ID,
      taskRepo: taskRepo.repo,
      sprintRepo,
      clock: FIXED_CLOCK,
      logger: noopLogger,
    });

    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(current.status).toBe('active');
    expect(retry.value.sprintReopened?.from).toBe('review');
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
    expect(result.value.task.status).toBe('todo'); // the task itself is revived either way
    // The sprint hops done → review → active in the same unblock call, re-using the existing
    // review → active step rather than a parallel done → active transition — both saves land.
    const history = sprintRepo.savedHistory();
    expect(history.map((s) => s.status)).toEqual(['review', 'active']);
    expect(sprintRepo.saved()?.status).toBe('active');
    expect(sprintRepo.saved()?.doneAt).toBeNull();
    // ...and the caller is told, so a closed sprint never reopens without the operator seeing it.
    expect(result.value.sprintReopened?.from).toBe('done');
    expect(result.value.sprintReopened?.sprint.status).toBe('active');
  });

  it('fails without touching the task when a done sprint cannot be carried to review', async () => {
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
      async list() {
        return Result.ok([doneSprint]);
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

    // Reviving the task anyway would leave `todo` work behind a `done` sprint — a state a retry can
    // no longer tell apart from a deliberate close-with-descoped-work. So the unblock fails as a
    // whole and the task stays blocked: re-running it takes the same path from the start.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('storage-error');
    expect(taskRepo.saved()).toHaveLength(0);
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
      async list() {
        return Result.ok([reviewSprint]);
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
    expect(result.value.task.status).toBe('todo');
    expect(result.value.sprintReopened).toBeUndefined();
  });

  // Single-active-per-project invariant on the `done` → `review` hop — the same one
  // `reopenDoneSprintUseCase` enforces (see reopen-sprint.test.ts's ConflictError case). `done`
  // does NOT hold the project, so a closed sprint may legally sit next to an active peer; carrying
  // it back to `review` next to that peer would put two sprints of one project on the shared
  // working tree, which the per-sprint-dir repo lock does not mutually exclude.
  it('leaves a done sprint closed when another sprint of the project is already active', async () => {
    const blocked = makeBlockedTask();
    const taskRepo = repoOk([blocked]);
    const doneSprint = makeDoneSprint();
    const activePeer = makeActiveSprint();
    const sprintRepo = sprintRepoWith(doneSprint, [doneSprint, activePeer]);

    const result = await unblockTaskUseCase({
      task: blocked,
      sprintId: SPRINT_ID,
      taskRepo: taskRepo.repo,
      sprintRepo: sprintRepo.repo,
      clock: FIXED_CLOCK,
      logger: noopLogger,
    });

    // The task IS revived — the reopen is best-effort, the unblock is not.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.task.status).toBe('todo');
    // ...but the sprint stays closed, and the caller is told why + which peer holds the project,
    // so the CLI/TUI can report the outcome truthfully instead of implying a reopen happened.
    expect(sprintRepo.savedHistory()).toHaveLength(0);
    const conflict = result.value.sprintReopenConflict;
    expect(conflict?.code).toBe('conflict');
    expect(conflict?.message).toContain(String(activePeer.slug));
    expect(conflict?.message).toContain('active');
    expect(conflict?.hint).toContain('ralphctl sprint close');
    expect(result.value.sprintReopened).toBeUndefined();
  });

  // The log is the ONLY channel some surfaces have for this outcome (the TUI's Recent-log panel
  // renders it; `bootstrapCli` attaches no log subscriber at all). A line saying the UNBLOCK was
  // refused would state the opposite of what happened — the task is revived, only the reopen is
  // refused — so the verb has to name the transition, not the command the operator typed.
  it('names the refused reopen — not the unblock — in the conflict log line', async () => {
    const blocked = makeBlockedTask();
    const taskRepo = repoOk([blocked]);
    const doneSprint = makeDoneSprint();
    const sprintRepo = sprintRepoWith(doneSprint, [doneSprint, makeActiveSprint()]);
    const { logger, warnings } = warnRecordingLogger();

    const result = await unblockTaskUseCase({
      task: blocked,
      sprintId: SPRINT_ID,
      taskRepo: taskRepo.repo,
      sprintRepo: sprintRepo.repo,
      clock: FIXED_CLOCK,
      logger,
    });

    expect(result.ok).toBe(true);
    const refusal = warnings.find((w) => w.startsWith('refusing to '));
    expect(refusal).toBe('refusing to reopen: another sprint already holds the project');
    // Same for the error the CLI prints as `note: …` — the unblock is not what was refused.
    if (!result.ok) return;
    expect(result.value.sprintReopenConflict?.message).toContain('cannot reopen sprint');
    expect(result.value.sprintReopenConflict?.message).not.toContain('cannot unblock');
  });

  it('reports no conflict — and reopens — when the only active sprint is in another project', async () => {
    const blocked = makeBlockedTask();
    const taskRepo = repoOk([blocked]);
    const doneSprint = makeDoneSprint();
    const otherProjectActive = { ...makeActiveSprint(), projectId: projectId('01900000-0000-7000-8000-0000000000bb') };
    const sprintRepo = sprintRepoWith(doneSprint, [doneSprint, otherProjectActive]);

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
    expect(result.value.sprintReopenConflict).toBeUndefined();
    expect(sprintRepo.savedHistory().map((s) => s.status)).toEqual(['review', 'active']);
  });

  it('fails without touching the task when the peer check cannot read the sprint list', async () => {
    const blocked = makeBlockedTask();
    const taskRepo = repoOk([blocked]);
    const doneSprint = makeDoneSprint();
    const sprintRepo: SprintRepo = {
      async findById() {
        return Result.ok(doneSprint);
      },
      async save() {
        return Result.ok(undefined);
      },
      async list() {
        return Result.error(new StorageError({ subCode: 'io', message: 'disk full', path: 'sprints' }));
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

    // An unreadable sprint list cannot establish that nobody holds the project, so the reopen
    // cannot run — and reviving the task without it would strand the work behind a closed sprint.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('storage-error');
    expect(taskRepo.saved()).toHaveLength(0);
  });

  it('fails without touching the task when the sprint cannot be loaded', async () => {
    const blocked = makeBlockedTask();
    const taskRepo = repoOk([blocked]);
    const sprintRepo: SprintRepo = {
      async findById() {
        return Result.error(new StorageError({ subCode: 'io', message: 'unreadable', path: 'sprint' }));
      },
      async save() {
        return Result.ok(undefined);
      },
      async list() {
        return Result.ok([]);
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

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('storage-error');
    expect(taskRepo.saved()).toHaveLength(0);
  });

  it('does not run the peer check for a review sprint — review → active adds no second holder', async () => {
    const blocked = makeBlockedTask();
    const taskRepo = repoOk([blocked]);
    const reviewSprint = makeReviewSprint();
    let listCalls = 0;
    const sprintRepo: SprintRepo = {
      async findById() {
        return Result.ok(reviewSprint);
      },
      async save() {
        return Result.ok(undefined);
      },
      async list() {
        listCalls += 1;
        return Result.ok([reviewSprint]);
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

    expect(result.ok).toBe(true);
    expect(listCalls).toBe(0);
  });
});
