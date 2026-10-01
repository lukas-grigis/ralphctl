import { describe, expect, it } from 'vitest';
import {
  buildAgenda,
  initialAgendaRowId,
  NEEDS_YOU_TASK_CAP,
  type AgendaSession,
  type BuildAgendaInput,
} from '@src/application/ui/tui/views/home-internals/agenda.ts';
import { visibleFlowsFor } from '@src/application/ui/tui/views/flows-visibility.ts';
import { markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { NextStep } from '@src/application/ui/shared/next-steps.ts';
import { makeTodoTask } from '@tests/fixtures/domain.ts';

const NOW = Date.parse('2026-10-01T12:00:00Z');
const SPRINT = 'sprint-1';
const HOUR = 3_600_000;

const ownBlocked = (id: string, name: string, reason = 'verify failed after 3 attempts'): Task => {
  const todo = makeTodoTask({ name });
  const r = markTaskBlocked({ ...todo, id: id as TaskId }, reason, 'own');
  if (!r.ok) throw new Error('fixture');
  return r.value;
};

const upstreamBlocked = (id: string, name: string, dependsOn: string[]): Task => {
  const todo = makeTodoTask({ name, dependsOn: dependsOn as TaskId[] });
  const r = markTaskBlocked({ ...todo, id: id as TaskId }, 'blocked upstream', 'upstream');
  if (!r.ok) throw new Error('fixture');
  return r.value;
};

const session = (over: Partial<AgendaSession> & { id: string }): AgendaSession => ({
  flowId: 'implement',
  status: 'running',
  startedAt: NOW - 60_000,
  pinnedSprintId: SPRINT,
  ...over,
});

const IMPLEMENT_STEP: NextStep = { flow: 'implement', label: 'Implement', detail: '2 tasks pending' };

const input = (over: Partial<BuildAgendaInput> = {}): BuildAgendaInput => ({
  tasks: [],
  sprintId: SPRINT,
  sessions: [],
  awaitingSince: new Map(),
  nextSteps: [IMPLEMENT_STEP],
  visibleFlows: visibleFlowsFor({ hasProject: true, sprintStatus: 'active', showAll: false }),
  showAll: false,
  launchability: () => ({ ok: true }),
  now: NOW,
  ...over,
});

const sections = (rows: ReturnType<typeof buildAgenda>): string[] => [...new Set(rows.map((r) => r.section))];

describe('buildAgenda', () => {
  it('orders sections needs-you > running > next > flows and omits empty ones', () => {
    const rows = buildAgenda(
      input({
        tasks: [ownBlocked('t1', 'Add test')],
        sessions: [session({ id: 's1', flowId: 'readiness' })],
        nextSteps: [IMPLEMENT_STEP],
      })
    );
    expect(sections(rows)).toEqual(['needs-you', 'running', 'next', 'flows']);
    expect(sections(buildAgenda(input()))).toEqual(['next', 'flows']);
    expect(sections(buildAgenda(input({ nextSteps: [], visibleFlows: new Set() })))).toEqual([]);
  });

  it('folds upstream-blocked dependents into the own-blocked row instead of listing them', () => {
    const rows = buildAgenda(
      input({
        tasks: [
          ownBlocked('t1', 'Add test'),
          upstreamBlocked('t2', 'Docs', ['t1']),
          upstreamBlocked('t3', 'Chain', ['t2']),
        ],
      })
    );
    const needs = rows.filter((r) => r.section === 'needs-you');
    expect(needs).toHaveLength(1);
    expect(needs[0]).toMatchObject({
      id: 'task:t1',
      label: '"Add test" is blocked',
      action: { kind: 'open-task', taskId: 't1' },
      verb: 'open task',
    });
    expect(needs[0]?.detail).toContain('verify failed after 3 attempts');
    expect(needs[0]?.detail).toContain('2 more tasks wait on it');
  });

  it('says "1 more task waits on it" for a single dependent', () => {
    const rows = buildAgenda(input({ tasks: [ownBlocked('t1', 'A'), upstreamBlocked('t2', 'B', ['t1'])] }));
    expect(rows[0]?.detail).toContain('1 more task waits on it');
  });

  it('caps own-blocked tasks at three and adds an overflow row', () => {
    const tasks = ['a', 'b', 'c', 'd', 'e'].map((n) => ownBlocked(`t-${n}`, n));
    const needs = buildAgenda(input({ tasks })).filter((r) => r.section === 'needs-you');
    expect(needs).toHaveLength(NEEDS_YOU_TASK_CAP + 1);
    expect(needs.at(-1)).toMatchObject({ id: 'needs-you:overflow', action: { kind: 'open-sprint' } });
    expect(needs.at(-1)?.label).toBe('2 more blocked — o open sprint');
  });

  it('lists failed and aborted sessions of this sprint from the last 24h only', () => {
    const rows = buildAgenda(
      input({
        sessions: [
          session({ id: 'recent', status: 'failed', finishedAt: NOW - 3 * HOUR }),
          session({ id: 'cancelled', status: 'aborted', flowId: 'plan', finishedAt: NOW - HOUR }),
          session({ id: 'old', status: 'failed', finishedAt: NOW - 25 * HOUR }),
          session({ id: 'other', status: 'failed', pinnedSprintId: 'sprint-2', finishedAt: NOW - HOUR }),
        ],
      })
    );
    const needs = rows.filter((r) => r.section === 'needs-you');
    expect(needs.map((r) => r.id)).toEqual(['run:recent', 'run:cancelled']);
    expect(needs[0]?.label).toBe('implement failed 3h ago');
    expect(needs[1]?.label).toBe('plan aborted 1h ago');
    expect(needs[0]?.action).toEqual({ kind: 'open-session', sessionId: 'recent' });
  });

  it('shows running sessions of this sprint with progress and elapsed, never another sprint', () => {
    const rows = buildAgenda(
      input({
        sessions: [
          session({
            id: 'run',
            progress: { taskIndex: 6, taskCount: 7, taskName: 'Add --shout option', attempt: 1, maxAttempts: 3 },
          }),
          session({ id: 'elsewhere', pinnedSprintId: 'sprint-2' }),
        ],
      })
    );
    const running = rows.filter((r) => r.section === 'running');
    expect(running).toHaveLength(1);
    expect(running[0]?.label).toBe('implement · task 6/7 "Add --shout option" · attempt 1/3');
    expect(running[0]?.fact).toBe('1m00s');
    expect(running[0]?.verb).toBe('open run');
  });

  it('marks an awaiting session in the fact', () => {
    const rows = buildAgenda(
      input({ sessions: [session({ id: 'run' })], awaitingSince: new Map([['run', NOW - 41_000]]) })
    );
    const row = rows.find((r) => r.section === 'running');
    expect(row?.fact).toBe('[WAITING] waiting 41s');
    expect(row?.tone).toBe('warning');
  });

  it('omits the NEXT row while its flow runs, and keeps it out of FLOWS too', () => {
    const rows = buildAgenda(input({ sessions: [session({ id: 'run' })] }));
    expect(rows.some((r) => r.section === 'next')).toBe(false);
    expect(rows.some((r) => r.id === 'flow:implement')).toBe(false);
  });

  it('does not repeat a NEXT flow under FLOWS', () => {
    const rows = buildAgenda(input());
    expect(rows.filter((r) => r.id === 'flow:implement')).toHaveLength(1);
    expect(rows.find((r) => r.id === 'flow:implement')?.section).toBe('next');
  });

  it('drops key-only next steps (their keys live in the footer)', () => {
    const rows = buildAgenda(input({ nextSteps: [{ key: 'a', label: 'add a ticket' }] }));
    expect(rows.some((r) => r.section === 'next')).toBe(false);
  });

  it('gives launch rows a `run <flow>` verb and only flows the status allows', () => {
    const visible = visibleFlowsFor({ hasProject: true, sprintStatus: 'draft', showAll: false });
    const rows = buildAgenda(input({ visibleFlows: visible, nextSteps: [] }));
    const launches = rows.flatMap((r) => (r.action.kind === 'launch-flow' ? [r] : []));
    expect(launches.length).toBeGreaterThan(0);
    for (const r of launches) {
      expect(r.action.kind === 'launch-flow' && visible.has(r.action.flowId)).toBe(true);
      expect(r.verb.startsWith('run ')).toBe(true);
    }
  });

  it('hides flows whose triggers fail, until showAll adds them dim with their reason', () => {
    const launchability = (id: string) =>
      id === 'readiness' ? ({ ok: false, disabledReason: 'no repository' } as const) : ({ ok: true } as const);
    const hidden = buildAgenda(input({ launchability }));
    expect(hidden.some((r) => r.id === 'flow:readiness')).toBe(false);

    const visible = visibleFlowsFor({ hasProject: true, sprintStatus: 'active', showAll: true });
    const all = buildAgenda(input({ launchability, showAll: true, visibleFlows: visible }));
    const readiness = all.find((r) => r.id === 'flow:readiness');
    expect(readiness?.disabledReason).toBe('no repository');
    expect(readiness?.tone).toBe('muted');
    expect(all.length).toBeGreaterThan(hidden.length);
  });

  it('keeps row ids stable across rebuilds', () => {
    const base = input({
      tasks: [ownBlocked('t1', 'A')],
      sessions: [session({ id: 'run' })],
    });
    const ids = (now: number): string[] => buildAgenda({ ...base, now }).map((r) => r.id);
    expect(ids(NOW)).toEqual(ids(NOW + 5 * 60_000));
  });
});

describe('initialAgendaRowId', () => {
  it('prefers NEEDS YOU, then NEXT, then the first enabled FLOWS row', () => {
    const withBlocked = buildAgenda(input({ tasks: [ownBlocked('t1', 'A')] }));
    expect(initialAgendaRowId(withBlocked)).toBe('task:t1');
    expect(initialAgendaRowId(buildAgenda(input()))).toBe('flow:implement');
    const flowsOnly = buildAgenda(input({ nextSteps: [] }));
    expect(initialAgendaRowId(flowsOnly)).toBe(flowsOnly[0]?.id);
    expect(initialAgendaRowId([])).toBeUndefined();
  });
});
