import { describe, expect, it } from 'vitest';
import {
  type ChainLogEntry,
  projectSprintState,
  STALE_THRESHOLD_HOURS,
} from '@src/business/sprint/state-projection.ts';
import {
  type Attempt,
  completeAttempt,
  recordAttemptEvaluation,
  recordAttemptVerification,
  startAttempt,
} from '@src/domain/entity/attempt.ts';
import { markTaskBlocked, type Task } from '@src/domain/entity/task.ts';
import { setExecutionBranch, recordExecutionPullRequestUrl } from '@src/domain/entity/sprint-execution.ts';
import {
  FIXED_LATER,
  FIXED_LATEST,
  FIXED_NOW,
  isoTimestamp,
  makeActiveSprint,
  makeApprovedTicket,
  makeDoneTask,
  makeDraftSprintBundle,
  makeInProgressTaskWithRunningAttempt,
  makeTodoTask,
} from '@tests/fixtures/domain.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';

const unwrap = <T, E>(r: { ok: true; value: T } | { ok: false; error: E }): T => {
  if (!r.ok) throw new Error('unwrap');
  return r.value;
};

const taskIdAs = (s: string): TaskId => s as unknown as TaskId;

const setAttempts = (task: Task, attempts: readonly Attempt[]): Task =>
  ({ ...task, attempts: attempts as Task['attempts'] }) as Task;

describe('projectSprintState', () => {
  const baseInputs = () => {
    const bundle = makeDraftSprintBundle();
    const sprint = makeActiveSprint();
    return { sprint, execution: bundle.execution };
  };

  it('returns counts, identity, and lossless ticket / task summaries on the happy path', () => {
    const { sprint, execution } = baseInputs();
    const done = makeDoneTask({ name: 'first' });
    const inProgress = makeInProgressTaskWithRunningAttempt();
    const todo = makeTodoTask({ name: 'third', order: 3 });
    const branched = setExecutionBranch(execution, 'feature/x');
    const withPr = unwrap(recordExecutionPullRequestUrl(branched, 'https://example.com/pr/1'));

    const state = projectSprintState({
      sprint,
      execution: withPr,
      tasks: [done, inProgress, todo],
      chainLogEntries: [],
      now: FIXED_LATEST,
    });

    expect(state.identity.id).toBe(sprint.id);
    expect(state.identity.name).toBe(sprint.name);
    expect(state.identity.activatedAt).toBe(sprint.activatedAt);
    expect(state.counts).toEqual({ total: 3, done: 1, inProgress: 1, blocked: 0, todo: 1 });
    expect(state.status).toEqual({ raw: 'active', effective: 'active' });
    expect(state.branch.name).toBe('feature/x');
    expect(state.branch.expected).toBe('feature/x');
    expect(state.branch.pullRequestUrl).toBe('https://example.com/pr/1');
    expect(state.branch.actual).toBeUndefined();
    expect(state.tickets).toHaveLength(sprint.tickets.length);
    expect(state.tasks).toHaveLength(3);
    expect(state.tasks[0]?.status).toBe('done');
    expect(state.tasks[0]?.attemptsCount).toBe(1);
    expect(state.tasks[0]?.lastAttempt?.status).toBe('verified');
    expect(state.runs).toEqual([]);
    expect(state.lastRun).toBeUndefined();
  });

  it('threads actualBranch through to branch.actual when supplied', () => {
    const { sprint, execution } = baseInputs();
    const state = projectSprintState({
      sprint,
      execution: setExecutionBranch(execution, 'feature/x'),
      tasks: [],
      chainLogEntries: [],
      now: FIXED_LATEST,
      actualBranch: 'feature/y',
    });
    expect(state.branch.actual).toBe('feature/y');
  });

  describe('effective status synthesis', () => {
    it('flags an active sprint as effectively blocked when every remaining task is blocked', () => {
      const { sprint, execution } = baseInputs();
      const blocked = unwrap(markTaskBlocked(makeTodoTask({ name: 'a' }), 'cannot proceed'));
      const done = makeDoneTask({ name: 'b' });
      const state = projectSprintState({
        sprint,
        execution,
        tasks: [done, blocked],
        chainLogEntries: [],
        now: FIXED_LATEST,
      });
      expect(state.status).toEqual({ raw: 'active', effective: 'blocked' });
    });

    it('keeps effective === raw when a non-blocked task is still pending', () => {
      const { sprint, execution } = baseInputs();
      const blocked = unwrap(markTaskBlocked(makeTodoTask({ name: 'a' }), 'cannot proceed'));
      const todo = makeTodoTask({ name: 'b', order: 2 });
      const state = projectSprintState({
        sprint,
        execution,
        tasks: [blocked, todo],
        chainLogEntries: [],
        now: FIXED_LATEST,
      });
      expect(state.status.effective).toBe('active');
    });

    it('does not synthesise blocked when every task is done', () => {
      const { sprint, execution } = baseInputs();
      const done = makeDoneTask({ name: 'a' });
      const state = projectSprintState({
        sprint,
        execution,
        tasks: [done],
        chainLogEntries: [],
        now: FIXED_LATEST,
      });
      expect(state.status.effective).toBe('active');
    });
  });

  describe('blockers', () => {
    it('surfaces both blocked-status tasks and tasks whose latest attempt failed', () => {
      const { sprint, execution } = baseInputs();
      const blockedTask = unwrap(markTaskBlocked(makeTodoTask({ name: 'gone' }), 'human stop'));
      const todo = makeTodoTask({ name: 'try-and-fail', order: 2 });
      const startedAttempt = unwrap(startAttempt({ n: 1, startedAt: FIXED_NOW }));
      const failed = unwrap(completeAttempt(startedAttempt, 'failed', FIXED_LATER));
      const withFail = setAttempts(todo, [failed]);

      const state = projectSprintState({
        sprint,
        execution,
        tasks: [blockedTask, withFail],
        chainLogEntries: [],
        now: FIXED_LATEST,
      });

      expect(state.blockers).toHaveLength(2);
      const [blockedEntry, failedEntry] = state.blockers;
      expect(blockedEntry?.reason).toBe('blocked-status');
      expect(blockedEntry?.detail).toBe('human stop');
      expect(failedEntry?.reason).toBe('last-attempt-failed');
      expect(failedEntry?.detail).toContain('failed');
    });

    it('returns no blockers when all tasks are running cleanly or done', () => {
      const { sprint, execution } = baseInputs();
      const state = projectSprintState({
        sprint,
        execution,
        tasks: [makeDoneTask(), makeInProgressTaskWithRunningAttempt()],
        chainLogEntries: [],
        now: FIXED_LATEST,
      });
      expect(state.blockers).toHaveLength(0);
    });
  });

  describe('stale heuristic', () => {
    const taskWithName = (name: string) => makeTodoTask({ name, order: 1 });

    it('flags a non-done task with no recent signal as stale', () => {
      const { sprint, execution } = baseInputs();
      const task = taskWithName('lonely');
      const now = isoTimestamp('2026-05-10T12:00:00.000Z');
      // 25h before now ⇒ stale.
      const signalAt = isoTimestamp('2026-05-09T10:59:00.000Z');
      const log: ChainLogEntry[] = [
        {
          timestamp: signalAt,
          chainId: 'c1',
          level: 'info',
          event: 'log',
          message: `working on ${task.name}`,
        },
      ];
      const state = projectSprintState({ sprint, execution, tasks: [task], chainLogEntries: log, now });
      expect(state.staleTasks).toHaveLength(1);
      expect(state.staleTasks[0]?.taskId).toBe(task.id);
      expect(state.staleTasks[0]?.lastSignalAt).toBe(signalAt);
      expect(state.staleTasks[0]?.hoursSinceSignal).toBeGreaterThan(STALE_THRESHOLD_HOURS);
    });

    it('does not flag a task with a signal just under 24h old', () => {
      const { sprint, execution } = baseInputs();
      const task = taskWithName('fresh');
      const now = isoTimestamp('2026-05-10T12:00:00.000Z');
      // 23h before now ⇒ fresh.
      const log: ChainLogEntry[] = [
        {
          timestamp: isoTimestamp('2026-05-09T13:30:00.000Z'),
          chainId: 'c1',
          level: 'info',
          event: 'log',
          message: `progress on ${task.name}`,
        },
      ];
      const state = projectSprintState({ sprint, execution, tasks: [task], chainLogEntries: log, now });
      expect(state.staleTasks).toHaveLength(0);
    });

    it('flags an in-progress task with no signal at all as stale', () => {
      const { sprint, execution } = baseInputs();
      const inProg = makeInProgressTaskWithRunningAttempt();
      const state = projectSprintState({
        sprint,
        execution,
        tasks: [inProg],
        chainLogEntries: [],
        now: FIXED_LATEST,
      });
      expect(state.staleTasks).toHaveLength(1);
      expect(state.staleTasks[0]?.lastSignalAt).toBeUndefined();
    });

    it('ignores done tasks even if they have no recent signal', () => {
      const { sprint, execution } = baseInputs();
      const done = makeDoneTask();
      const state = projectSprintState({
        sprint,
        execution,
        tasks: [done],
        chainLogEntries: [],
        now: FIXED_LATEST,
      });
      expect(state.staleTasks).toHaveLength(0);
    });

    it('matches by meta.taskId without needing the task id in the message', () => {
      const { sprint, execution } = baseInputs();
      const task = taskWithName('signal-via-meta');
      const now = isoTimestamp('2026-05-10T12:00:00.000Z');
      const log: ChainLogEntry[] = [
        {
          timestamp: isoTimestamp('2026-05-10T11:00:00.000Z'),
          chainId: 'c1',
          level: 'info',
          event: 'log',
          message: 'something happened',
          meta: { taskId: task.id },
        },
      ];
      const state = projectSprintState({ sprint, execution, tasks: [task], chainLogEntries: log, now });
      expect(state.staleTasks).toHaveLength(0);
    });
  });

  describe('dependency cycles', () => {
    it('returns no cycles on a sound graph', () => {
      const { sprint, execution } = baseInputs();
      const a = makeTodoTask({ name: 'a', order: 1 });
      const b = makeTodoTask({ name: 'b', order: 2, dependsOn: [a.id] });
      const state = projectSprintState({
        sprint,
        execution,
        tasks: [a, b],
        chainLogEntries: [],
        now: FIXED_LATEST,
      });
      expect(state.dependencyCycles).toHaveLength(0);
    });

    it('detects a simple two-node cycle', () => {
      const { sprint, execution } = baseInputs();
      const a = makeTodoTask({ name: 'a', order: 1 });
      const b = makeTodoTask({ name: 'b', order: 2, dependsOn: [a.id] });
      // close the loop: a depends on b too.
      const aLoop = { ...a, dependsOn: [b.id] } as typeof a;
      const state = projectSprintState({
        sprint,
        execution,
        tasks: [aLoop, b],
        chainLogEntries: [],
        now: FIXED_LATEST,
      });
      expect(state.dependencyCycles).toHaveLength(1);
      expect(state.dependencyCycles[0]).toHaveLength(2);
    });

    it('detects a multi-node cycle', () => {
      const { sprint, execution } = baseInputs();
      const a = makeTodoTask({ name: 'a', order: 1 });
      const b = makeTodoTask({ name: 'b', order: 2 });
      const c = makeTodoTask({ name: 'c', order: 3 });
      const aLoop = { ...a, dependsOn: [c.id] } as typeof a;
      const bLoop = { ...b, dependsOn: [a.id] } as typeof b;
      const cLoop = { ...c, dependsOn: [b.id] } as typeof c;
      const state = projectSprintState({
        sprint,
        execution,
        tasks: [aLoop, bLoop, cLoop],
        chainLogEntries: [],
        now: FIXED_LATEST,
      });
      expect(state.dependencyCycles).toHaveLength(1);
      expect(state.dependencyCycles[0]).toHaveLength(3);
    });

    it('synthesises a single-element cycle for orphan dependency refs', () => {
      const { sprint, execution } = baseInputs();
      const orphanId = taskIdAs('01900000-0000-7000-8000-00000000ffff');
      const task = makeTodoTask({ name: 'a', dependsOn: [orphanId] });
      const state = projectSprintState({
        sprint,
        execution,
        tasks: [task],
        chainLogEntries: [],
        now: FIXED_LATEST,
      });
      expect(state.dependencyCycles).toHaveLength(1);
      expect(state.dependencyCycles[0]).toEqual([String(orphanId)]);
    });
  });

  describe('run boundaries', () => {
    const ts = (s: string): IsoTimestamp => isoTimestamp(s);

    it('groups interleaved entries by chainId and stamps started/finished + outcome', () => {
      const { sprint, execution } = baseInputs();
      const log: ChainLogEntry[] = [
        { timestamp: ts('2026-05-10T10:00:00.000Z'), chainId: 'A', level: 'info', event: 'chain-started', message: '' },
        { timestamp: ts('2026-05-10T10:00:01.000Z'), chainId: 'B', level: 'info', event: 'chain-started', message: '' },
        {
          timestamp: ts('2026-05-10T10:00:02.000Z'),
          chainId: 'A',
          level: 'info',
          event: 'chain-step-completed',
          message: '',
        },
        {
          timestamp: ts('2026-05-10T10:00:03.000Z'),
          chainId: 'B',
          level: 'info',
          event: 'chain-step-failed',
          message: '',
        },
        {
          timestamp: ts('2026-05-10T10:00:04.000Z'),
          chainId: 'A',
          level: 'info',
          event: 'chain-completed',
          message: '',
        },
        { timestamp: ts('2026-05-10T10:00:05.000Z'), chainId: 'B', level: 'info', event: 'chain-failed', message: '' },
      ];
      const state = projectSprintState({
        sprint,
        execution,
        tasks: [],
        chainLogEntries: log,
        now: FIXED_LATEST,
      });
      expect(state.runs).toHaveLength(2);
      const [runA, runB] = state.runs;
      expect(runA?.chainId).toBe('A');
      expect(runA?.outcome).toBe('completed');
      expect(runA?.stepsCompleted).toBe(1);
      expect(runA?.stepsFailed).toBe(0);
      expect(runA?.finishedAt).toBe(ts('2026-05-10T10:00:04.000Z'));
      expect(runB?.outcome).toBe('failed');
      expect(runB?.stepsFailed).toBe(1);
      expect(state.lastRun?.chainId).toBe('B');
    });

    it('marks a run with no terminal event as in-progress', () => {
      const { sprint, execution } = baseInputs();
      const log: ChainLogEntry[] = [
        { timestamp: ts('2026-05-10T10:00:00.000Z'), chainId: 'C', level: 'info', event: 'chain-started', message: '' },
        {
          timestamp: ts('2026-05-10T10:00:01.000Z'),
          chainId: 'C',
          level: 'info',
          event: 'chain-step-started',
          message: '',
        },
      ];
      const state = projectSprintState({
        sprint,
        execution,
        tasks: [],
        chainLogEntries: log,
        now: FIXED_LATEST,
      });
      expect(state.runs[0]?.outcome).toBe('in-progress');
      expect(state.runs[0]?.finishedAt).toBeUndefined();
    });

    it('picks up flowId from chain-started meta when present', () => {
      const { sprint, execution } = baseInputs();
      const log: ChainLogEntry[] = [
        {
          timestamp: ts('2026-05-10T10:00:00.000Z'),
          chainId: 'D',
          level: 'info',
          event: 'chain-started',
          message: '',
          meta: { flowId: 'implement' },
        },
      ];
      const state = projectSprintState({
        sprint,
        execution,
        tasks: [],
        chainLogEntries: log,
        now: FIXED_LATEST,
      });
      expect(state.runs[0]?.flowId).toBe('implement');
    });
  });

  describe('decisions', () => {
    it('mines entries whose event is `decision`', () => {
      const { sprint, execution } = baseInputs();
      const log: ChainLogEntry[] = [
        {
          timestamp: isoTimestamp('2026-05-10T10:00:00.000Z'),
          chainId: 'A',
          level: 'info',
          event: 'decision',
          message: 'chose option B',
          meta: { reason: 'cheaper' },
        },
        {
          timestamp: isoTimestamp('2026-05-10T10:00:01.000Z'),
          chainId: 'A',
          level: 'info',
          event: 'log',
          message: 'unrelated',
        },
      ];
      const state = projectSprintState({
        sprint,
        execution,
        tasks: [],
        chainLogEntries: log,
        now: FIXED_LATEST,
      });
      expect(state.decisions).toHaveLength(1);
      expect(state.decisions[0]?.message).toBe('chose option B');
      expect(state.decisions[0]?.meta?.['reason']).toBe('cheaper');
    });

    it('also accepts meta.signalKind === decision as the marker', () => {
      const { sprint, execution } = baseInputs();
      const log: ChainLogEntry[] = [
        {
          timestamp: isoTimestamp('2026-05-10T10:00:00.000Z'),
          chainId: 'A',
          level: 'info',
          event: 'log',
          message: 'decision: keep cache',
          meta: { signalKind: 'decision' },
        },
      ];
      const state = projectSprintState({
        sprint,
        execution,
        tasks: [],
        chainLogEntries: log,
        now: FIXED_LATEST,
      });
      expect(state.decisions).toHaveLength(1);
    });
  });

  describe('median round duration', () => {
    const taskWithAttempts = (durations: readonly number[]): Task => {
      const todo = makeTodoTask({ name: 'm', order: 1 });
      const attempts: Attempt[] = [];
      const startMs = new Date(FIXED_NOW).getTime();
      durations.forEach((dur, i) => {
        const startedAt = isoTimestamp(new Date(startMs + i * 100_000).toISOString());
        const finishedAt = isoTimestamp(new Date(startMs + i * 100_000 + dur).toISOString());
        const running = unwrap(startAttempt({ n: i + 1, startedAt }));
        const withVerif = recordAttemptVerification(running);
        const evalu = recordAttemptEvaluation(withVerif, { status: 'passed', file: 'eval.md' });
        const settled = unwrap(completeAttempt(evalu, 'verified', finishedAt));
        attempts.push(settled);
      });
      return setAttempts(todo, attempts);
    };

    it('returns undefined when there are no settled attempts', () => {
      const { sprint, execution } = baseInputs();
      const inProg = makeInProgressTaskWithRunningAttempt();
      const state = projectSprintState({
        sprint,
        execution,
        tasks: [inProg],
        chainLogEntries: [],
        now: FIXED_LATEST,
      });
      expect(state.tasks[0]?.medianRoundDurationMs).toBeUndefined();
    });

    it('returns the single duration when there is exactly one settled attempt', () => {
      const { sprint, execution } = baseInputs();
      const task = taskWithAttempts([5_000]);
      const state = projectSprintState({
        sprint,
        execution,
        tasks: [task],
        chainLogEntries: [],
        now: FIXED_LATEST,
      });
      expect(state.tasks[0]?.medianRoundDurationMs).toBe(5_000);
    });

    it('returns the middle of an odd-length set', () => {
      const { sprint, execution } = baseInputs();
      const task = taskWithAttempts([3_000, 1_000, 5_000]);
      const state = projectSprintState({
        sprint,
        execution,
        tasks: [task],
        chainLogEntries: [],
        now: FIXED_LATEST,
      });
      expect(state.tasks[0]?.medianRoundDurationMs).toBe(3_000);
    });

    it('returns the mean of the two middles for an even-length set', () => {
      const { sprint, execution } = baseInputs();
      const task = taskWithAttempts([1_000, 2_000, 4_000, 8_000]);
      const state = projectSprintState({
        sprint,
        execution,
        tasks: [task],
        chainLogEntries: [],
        now: FIXED_LATEST,
      });
      expect(state.tasks[0]?.medianRoundDurationMs).toBe(3_000);
    });
  });

  describe('ticket summaries', () => {
    it('passes status + externalRef through losslessly', () => {
      const ticket = makeApprovedTicket({ externalRef: '#42' });
      const sprint = { ...makeActiveSprint(), tickets: [ticket] } as typeof ticket extends never
        ? never
        : ReturnType<typeof makeActiveSprint>;
      const bundle = makeDraftSprintBundle();
      const state = projectSprintState({
        sprint,
        execution: bundle.execution,
        tasks: [],
        chainLogEntries: [],
        now: FIXED_LATEST,
      });
      expect(state.tickets).toEqual([{ id: ticket.id, title: ticket.title, status: 'approved', externalRef: '#42' }]);
    });
  });
});
