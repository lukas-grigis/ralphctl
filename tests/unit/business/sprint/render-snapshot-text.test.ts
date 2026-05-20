/**
 * Tests for the CLI snapshot renderer. Stable, byte-exact assertions on the small surface so
 * downstream "copy this into a bug report" callers get the same output across versions.
 */

import { describe, expect, it } from 'vitest';
import { renderSnapshotText } from '@src/business/sprint/render-snapshot-text.ts';
import type { ChainLogEntry, SprintState, TaskProjection } from '@src/business/sprint/state-projection.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';

const ts = (s: string): IsoTimestamp => s as unknown as IsoTimestamp;

const minimalState = (overrides: Partial<SprintState> = {}): SprintState => ({
  identity: {
    id: 'sprint-1',
    name: 'demo sprint',
    activatedAt: ts('2026-05-08T10:00:00.000Z'),
  },
  status: { raw: 'active', effective: 'active' },
  counts: { total: 0, done: 0, inProgress: 0, blocked: 0, todo: 0 },
  branch: { name: 'ralphctl/abc', pullRequestUrl: undefined, expected: 'ralphctl/abc' },
  tickets: [],
  tasks: [],
  blockers: [],
  staleTasks: [],
  dependencyCycles: [],
  decisions: [],
  runs: [],
  ...overrides,
});

const task = (overrides: Partial<TaskProjection> = {}): TaskProjection => ({
  id: 'task-1',
  name: 'wire clipboard',
  status: 'in_progress',
  order: 1,
  ticketId: 'ticket-1',
  repositoryId: 'repo-1',
  blockedBy: [],
  attemptsCount: 1,
  ...overrides,
});

describe('renderSnapshotText', () => {
  it('renders header + status with branch name and counts', () => {
    const out = renderSnapshotText({
      state: minimalState(),
      projectLabel: 'ralphctl',
      chainLogEntries: [],
    });
    expect(out).toContain('Sprint: demo sprint');
    expect(out).toContain('  id: sprint-1');
    expect(out).toContain('Status');
    expect(out).toContain('  project: ralphctl');
    expect(out).toContain('  status:  active');
    expect(out).toContain('  branch:  ralphctl/abc');
    expect(out).toContain('  tasks:   0/0 done · 0 in progress · 0 todo · 0 blocked');
    // No tasks / active / recent-signals sections when empty.
    expect(out).not.toContain('Tasks\n');
    expect(out).not.toContain('Active');
    expect(out).not.toContain('Recent signals');
    // Trailing newline so stdout doesn't smush against the shell prompt.
    expect(out.endsWith('\n')).toBe(true);
  });

  it('renders the tasks table when at least one task exists', () => {
    const state = minimalState({
      counts: { total: 2, done: 1, inProgress: 1, blocked: 0, todo: 0 },
      tasks: [
        task({
          order: 1,
          name: 'finish thing',
          status: 'done',
          attemptsCount: 1,
          lastAttempt: {
            n: 1,
            status: 'completed',
            verdict: 'passed',
            commitSha: 'deadbeef1234567',
            startedAt: ts('2026-05-08T10:00:00.000Z'),
            finishedAt: ts('2026-05-08T10:05:00.000Z'),
          },
        }),
        task({ id: 'task-2', order: 2, name: 'next thing', status: 'in_progress', attemptsCount: 0 }),
      ],
    });
    const out = renderSnapshotText({ state, chainLogEntries: [] });
    expect(out).toContain('Tasks');
    expect(out).toContain('  | 1 | finish thing | done | 1 | passed | deadbee |');
    expect(out).toContain('  | 2 | next thing | in_progress | 0 |  |  |');
  });

  it('renders the active block for the first non-done task', () => {
    const state = minimalState({
      counts: { total: 2, done: 1, inProgress: 1, blocked: 0, todo: 0 },
      tasks: [
        task({ order: 1, name: 'first', status: 'done' }),
        task({
          id: 'task-2',
          order: 2,
          name: 'live now',
          status: 'in_progress',
          attemptsCount: 1,
          lastAttempt: {
            n: 1,
            status: 'running',
            startedAt: ts('2026-05-08T10:30:00.000Z'),
          },
        }),
      ],
    });
    const out = renderSnapshotText({ state, chainLogEntries: [] });
    expect(out).toContain('Active');
    expect(out).toContain('  task:     live now');
    expect(out).toContain('  attempt:  n=1 · running');
  });

  it('renders the recent-signals tail using meta.signalKind entries only', () => {
    const entries: ChainLogEntry[] = [
      {
        timestamp: ts('2026-05-08T10:00:00.000Z'),
        chainId: 'r-1',
        level: 'info',
        event: 'log',
        message: 'noise — not a signal',
      },
      {
        timestamp: ts('2026-05-08T10:01:00.000Z'),
        chainId: 'r-1',
        level: 'info',
        event: 'log',
        message: 'added clipboard adapter',
        meta: { signalKind: 'change' },
      },
      {
        timestamp: ts('2026-05-08T10:02:30.000Z'),
        chainId: 'r-1',
        level: 'info',
        event: 'log',
        message: 'evaluator gave 5/5',
        meta: { signalKind: 'verified' },
      },
    ];
    const out = renderSnapshotText({ state: minimalState(), chainLogEntries: entries });
    expect(out).toContain('Recent signals');
    // Newest first; HH:MM:SS UTC; padded kind column.
    expect(out).toContain('10:02:30  verified    evaluator gave 5/5');
    expect(out).toContain('10:01:00  change      added clipboard adapter');
    expect(out).not.toContain('noise — not a signal');
  });

  it('renders an absent branch as a friendly placeholder', () => {
    const state = minimalState({ branch: { name: undefined, pullRequestUrl: undefined, expected: undefined } });
    const out = renderSnapshotText({ state, chainLogEntries: [] });
    expect(out).toContain('  branch:  (none — first implement run will assign one)');
  });
});
