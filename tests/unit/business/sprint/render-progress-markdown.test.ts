import { describe, expect, it } from 'vitest';
import { renderProgressMarkdown } from '@src/business/sprint/render-progress-markdown.ts';
import type {
  BlockerEntry,
  DecisionEntry,
  RunBoundary,
  SprintState,
  StaleEntry,
  TaskProjection,
  TicketSummary,
} from '@src/business/sprint/state-projection.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { isoTimestamp } from '@tests/fixtures/domain.ts';

const ts = (s: string): IsoTimestamp => isoTimestamp(s);

const minimalState = (): SprintState => ({
  identity: {
    id: 'sprint-id-1',
    name: 'demo',
    activatedAt: ts('2026-05-08T10:00:00.000Z'),
  },
  status: { raw: 'active', effective: 'active' },
  counts: { total: 0, done: 0, inProgress: 0, blocked: 0, todo: 0 },
  branch: { name: undefined, pullRequestUrl: undefined, expected: undefined },
  tickets: [],
  tasks: [],
  blockers: [],
  staleTasks: [],
  dependencyCycles: [],
  decisions: [],
  runs: [],
});

describe('renderProgressMarkdown', () => {
  describe('minimal sprint', () => {
    it('renders only the Status section (and header) when every other collection is empty', () => {
      const out = renderProgressMarkdown(minimalState());
      expect(out).toContain('# Sprint progress — demo');
      expect(out).toContain('## Status');
      expect(out).toContain('- id: sprint-id-1');
      expect(out).toContain('- status: active');
      expect(out).toContain('- 0/0 done · 0 in progress · 0 blocked');
      expect(out).toContain('activated: 2026-05-08T10:00:00.000Z');
      // Sections with no content are omitted entirely (no "(none)" placeholders).
      expect(out).not.toContain('## Branch & PR');
      expect(out).not.toContain('## Tickets');
      expect(out).not.toContain('## Tasks');
      expect(out).not.toContain('## Blockers');
      expect(out).not.toContain('## Stale tasks');
      expect(out).not.toContain('## Dependency cycles');
      expect(out).not.toContain('## Decisions');
      expect(out).not.toContain('## Recent runs');
    });

    it('renders activated as em-dash when no activatedAt is present', () => {
      const state = minimalState();
      const noActivated: SprintState = {
        ...state,
        identity: { id: state.identity.id, name: state.identity.name },
      };
      const out = renderProgressMarkdown(noActivated);
      expect(out).toContain('activated: —');
    });

    it('appends review and done timestamps when present', () => {
      const state = minimalState();
      const full: SprintState = {
        ...state,
        identity: {
          ...state.identity,
          reviewAt: ts('2026-05-09T10:00:00.000Z'),
          doneAt: ts('2026-05-10T10:00:00.000Z'),
        },
      };
      const out = renderProgressMarkdown(full);
      expect(out).toContain('review: 2026-05-09T10:00:00.000Z');
      expect(out).toContain('done: 2026-05-10T10:00:00.000Z');
    });
  });

  describe('effective status synthesis', () => {
    it('renders the synthesised `blocked` even though raw is `active`', () => {
      const state: SprintState = {
        ...minimalState(),
        status: { raw: 'active', effective: 'blocked' },
        counts: { total: 1, done: 0, inProgress: 0, blocked: 1, todo: 0 },
      };
      const out = renderProgressMarkdown(state);
      expect(out).toContain('- status: blocked');
      // Not raw.
      expect(out).not.toContain('- status: active');
    });
  });

  describe('branch + PR', () => {
    it('renders only the branch line when no PR is recorded', () => {
      const state: SprintState = {
        ...minimalState(),
        branch: { name: 'feature/x', pullRequestUrl: undefined, expected: 'feature/x' },
      };
      const out = renderProgressMarkdown(state);
      expect(out).toContain('## Branch & PR');
      expect(out).toContain('- branch: feature/x');
      expect(out).not.toContain('- pull request:');
      // Expected matches actual when actual is absent — no mismatch annotation.
      expect(out).not.toContain('(expected');
    });

    it('renders the mismatch annotation only when expected ≠ actual', () => {
      const state: SprintState = {
        ...minimalState(),
        branch: {
          name: 'feature/x',
          pullRequestUrl: undefined,
          expected: 'feature/x',
          actual: 'feature/y',
        },
      };
      const out = renderProgressMarkdown(state);
      expect(out).toContain('- branch: feature/x (expected feature/x, actual feature/y)');
    });

    it('omits the mismatch annotation when expected equals actual', () => {
      const state: SprintState = {
        ...minimalState(),
        branch: {
          name: 'feature/x',
          pullRequestUrl: undefined,
          expected: 'feature/x',
          actual: 'feature/x',
        },
      };
      const out = renderProgressMarkdown(state);
      expect(out).toContain('- branch: feature/x');
      expect(out).not.toContain('(expected');
    });

    it('omits the Branch & PR section entirely when branch and PR are both undefined', () => {
      const out = renderProgressMarkdown(minimalState());
      expect(out).not.toContain('## Branch & PR');
    });

    it('includes the pull request line when present', () => {
      const state: SprintState = {
        ...minimalState(),
        branch: {
          name: 'feature/x',
          pullRequestUrl: 'https://example.com/pr/1',
          expected: 'feature/x',
        },
      };
      const out = renderProgressMarkdown(state);
      expect(out).toContain('- pull request: https://example.com/pr/1');
    });
  });

  describe('tickets', () => {
    it('renders ticket lines including external ref bracket when present', () => {
      const tickets: TicketSummary[] = [
        { id: 'tkt-1', title: 'fix login', status: 'approved', externalRef: 'JIRA-42' },
        { id: 'tkt-2', title: 'add docs', status: 'pending' },
      ];
      const state: SprintState = { ...minimalState(), tickets };
      const out = renderProgressMarkdown(state);
      expect(out).toContain('## Tickets');
      expect(out).toContain('- tkt-1 — fix login [JIRA-42]');
      expect(out).toContain('  status: approved');
      expect(out).toContain('- tkt-2 — add docs');
      expect(out).not.toContain('- tkt-2 — add docs [');
    });
  });

  describe('tasks table', () => {
    const baseTask = (overrides: Partial<TaskProjection>): TaskProjection => ({
      id: 't1',
      name: 'do work',
      status: 'todo',
      order: 1,
      ticketId: 'tkt-1',
      repositoryId: 'repo-1',
      blockedBy: [],
      attemptsCount: 0,
      ...overrides,
    });

    it('renders the tasks table with truncated commit SHA and verdict', () => {
      const tasks: TaskProjection[] = [
        baseTask({
          id: 't1',
          name: 'first',
          status: 'done',
          order: 1,
          attemptsCount: 2,
          lastAttempt: {
            n: 2,
            status: 'verified',
            verdict: 'passed',
            commitSha: 'abcdef1234567890',
            startedAt: ts('2026-05-08T10:00:00.000Z'),
            finishedAt: ts('2026-05-08T10:30:00.000Z'),
            durationMs: 30 * 60 * 1000,
          },
        }),
        baseTask({ id: 't2', name: 'second', order: 2 }),
      ];
      const state: SprintState = { ...minimalState(), tasks };
      const out = renderProgressMarkdown(state);
      expect(out).toContain('## Tasks');
      expect(out).toContain('| # | name | status | attempts | last verdict | commit |');
      expect(out).toContain('|---|------|--------|----------|--------------|--------|');
      expect(out).toContain('| 1 | first | done | 2 | passed | abcdef1 |');
      expect(out).toContain('| 2 | second | todo | 0 |  |  |');
      // SHA truncated to 7 chars.
      expect(out).not.toContain('abcdef1234567890');
    });
  });

  describe('section omission', () => {
    it('omits Blockers when empty', () => {
      expect(renderProgressMarkdown(minimalState())).not.toContain('## Blockers');
    });

    it('renders Blockers as ✗ lines when populated', () => {
      const blockers: BlockerEntry[] = [
        { taskId: 't1', name: 'first', reason: 'blocked-status', detail: 'human stop' },
      ];
      const out = renderProgressMarkdown({ ...minimalState(), blockers });
      expect(out).toContain('## Blockers');
      expect(out).toContain('- ✗ first — human stop');
    });

    it('renders Stale tasks with hours rounded to whole hours', () => {
      const stale: StaleEntry[] = [
        {
          taskId: 't1',
          name: 'lonely',
          lastSignalAt: ts('2026-05-07T10:00:00.000Z'),
          hoursSinceSignal: 25.4,
        },
      ];
      const out = renderProgressMarkdown({ ...minimalState(), staleTasks: stale });
      expect(out).toContain('## Stale tasks');
      expect(out).toContain('- ⚠ lonely — 25h since last signal');
    });

    it('renders Stale tasks as days after 48h', () => {
      const stale: StaleEntry[] = [
        {
          taskId: 't1',
          name: 'long-gone',
          lastSignalAt: ts('2026-05-01T10:00:00.000Z'),
          hoursSinceSignal: 72,
        },
      ];
      const out = renderProgressMarkdown({ ...minimalState(), staleTasks: stale });
      expect(out).toContain('- ⚠ long-gone — 3d since last signal');
    });

    it('renders Stale tasks with "no signal recorded" when hoursSinceSignal is undefined', () => {
      const stale: StaleEntry[] = [{ taskId: 't1', name: 'no-signal' }];
      const out = renderProgressMarkdown({ ...minimalState(), staleTasks: stale });
      expect(out).toContain('- ⚠ no-signal — no signal recorded');
    });

    it('renders dependency cycles joined by → arrow', () => {
      const cycles: ReadonlyArray<readonly string[]> = [['a', 'b', 'c']];
      const out = renderProgressMarkdown({ ...minimalState(), dependencyCycles: cycles });
      expect(out).toContain('## Dependency cycles');
      expect(out).toContain('- a → b → c');
    });

    it('renders Decisions with timestamp + tag + message', () => {
      const decisions: DecisionEntry[] = [
        {
          chainId: 'c-1',
          at: ts('2026-05-08T11:00:00.000Z'),
          message: 'picked option B',
          meta: { taskId: 't-99' },
        },
        {
          chainId: 'c-2',
          at: ts('2026-05-08T12:00:00.000Z'),
          message: 'no task ref',
        },
      ];
      const out = renderProgressMarkdown({ ...minimalState(), decisions });
      expect(out).toContain('## Decisions');
      expect(out).toContain('- 2026-05-08T11:00:00.000Z [t-99] picked option B');
      // Falls back to chainId when no taskId on meta.
      expect(out).toContain('- 2026-05-08T12:00:00.000Z [c-2] no task ref');
    });

    it('clips an over-cap decision message with an ellipsis + (+N chars) overflow hint', () => {
      const longMessage = 'x'.repeat(200);
      const decisions: DecisionEntry[] = [
        {
          chainId: 'c-1',
          at: ts('2026-05-08T11:00:00.000Z'),
          message: longMessage,
          meta: { taskId: 't-99' },
        },
      ];
      const out = renderProgressMarkdown({ ...minimalState(), decisions });
      expect(out).toContain('## Decisions');
      // 200 chars total, 160 cap → 40-char overflow hint.
      expect(out).toContain(`- 2026-05-08T11:00:00.000Z [t-99] ${'x'.repeat(160)}… (+40 chars)`);
      // Full body must NOT appear verbatim — clipping is load-bearing.
      expect(out).not.toContain('x'.repeat(200));
    });
  });

  describe('recent runs', () => {
    const run = (overrides: Partial<RunBoundary>): RunBoundary => ({
      chainId: 'r1',
      startedAt: ts('2026-05-08T10:00:00.000Z'),
      finishedAt: ts('2026-05-08T10:00:05.000Z'),
      outcome: 'completed',
      stepsCompleted: 5,
      stepsFailed: 0,
      ...overrides,
    });

    it('renders the last 3 runs newest first with duration formatting', () => {
      const runs: RunBoundary[] = [
        run({
          chainId: 'r1',
          startedAt: ts('2026-05-08T10:00:00.000Z'),
          finishedAt: ts('2026-05-08T10:00:00.500Z'),
          flowId: 'implement',
        }),
        run({
          chainId: 'r2',
          startedAt: ts('2026-05-08T10:01:00.000Z'),
          finishedAt: ts('2026-05-08T10:01:05.000Z'),
          flowId: 'plan',
        }),
        run({
          chainId: 'r3',
          startedAt: ts('2026-05-08T10:02:00.000Z'),
          finishedAt: ts('2026-05-08T11:32:15.000Z'),
          flowId: 'implement',
          stepsCompleted: 10,
          stepsFailed: 1,
        }),
        run({
          chainId: 'r4',
          startedAt: ts('2026-05-08T10:03:00.000Z'),
          finishedAt: ts('2026-05-08T10:03:30.000Z'),
          flowId: 'implement',
        }),
      ];
      const out = renderProgressMarkdown({ ...minimalState(), runs });
      expect(out).toContain('## Recent runs');
      const idx2 = out.indexOf('r2');
      const idx3 = out.indexOf('r3');
      const idx4 = out.indexOf('r4');
      const idx1 = out.indexOf('r1');
      // Newest first: r4 → r3 → r2; r1 excluded (limit 3).
      expect(idx4).toBeGreaterThan(-1);
      expect(idx3).toBeGreaterThan(idx4);
      expect(idx2).toBeGreaterThan(idx3);
      expect(idx1).toBe(-1);
      // Sub-second duration: ms.
      expect(out).not.toContain('500ms'); // r1 excluded
      // 5s → "5s".
      expect(out).toContain('· 5s ·');
      // 1h 30m 15s.
      expect(out).toContain('· 1h 30m 15s ·');
      // step format.
      expect(out).toContain('· 10/11 steps');
    });

    it('renders sub-second durations as ms', () => {
      const runs: RunBoundary[] = [
        run({
          chainId: 'rfast',
          startedAt: ts('2026-05-08T10:00:00.000Z'),
          finishedAt: ts('2026-05-08T10:00:00.250Z'),
        }),
      ];
      const out = renderProgressMarkdown({ ...minimalState(), runs });
      expect(out).toContain('· 250ms ·');
    });

    it('marks in-progress runs as in-progress when finishedAt is undefined', () => {
      const live: RunBoundary = {
        chainId: 'rlive',
        startedAt: ts('2026-05-08T10:00:00.000Z'),
        outcome: 'in-progress',
        stepsCompleted: 0,
        stepsFailed: 0,
      };
      const out = renderProgressMarkdown({ ...minimalState(), runs: [live] });
      expect(out).toContain('· in-progress · in-progress ·');
    });

    it('falls back to "unknown" flow id when flowId is undefined', () => {
      const runs: RunBoundary[] = [
        run({
          chainId: 'rnoflow',
          startedAt: ts('2026-05-08T10:00:00.000Z'),
          finishedAt: ts('2026-05-08T10:00:01.000Z'),
        }),
      ];
      const out = renderProgressMarkdown({ ...minimalState(), runs });
      expect(out).toContain('· unknown ·');
    });
  });

  describe('determinism', () => {
    it('produces the same string twice for the same input', () => {
      const state: SprintState = {
        ...minimalState(),
        tickets: [{ id: 't1', title: 'one', status: 'approved' }],
        tasks: [
          {
            id: 'task-1',
            name: 'task one',
            status: 'done',
            order: 1,
            ticketId: 't1',
            repositoryId: 'r1',
            blockedBy: [],
            attemptsCount: 1,
          },
        ],
      };
      expect(renderProgressMarkdown(state)).toBe(renderProgressMarkdown(state));
    });
  });

  describe('full-state snapshot', () => {
    it('renders the expected document for a fully-populated state', () => {
      const state: SprintState = {
        identity: {
          id: 'sprint-1',
          name: 'demo',
          activatedAt: ts('2026-05-08T10:00:00.000Z'),
          reviewAt: ts('2026-05-09T10:00:00.000Z'),
        },
        status: { raw: 'active', effective: 'blocked' },
        counts: { total: 3, done: 1, inProgress: 1, blocked: 1, todo: 0 },
        branch: {
          name: 'feature/x',
          pullRequestUrl: 'https://example.com/pr/1',
          expected: 'feature/x',
          actual: 'feature/y',
        },
        tickets: [{ id: 'tkt-1', title: 'fix login', status: 'approved', externalRef: 'JIRA-42' }],
        tasks: [
          {
            id: 'task-1',
            name: 'wire form',
            status: 'done',
            order: 1,
            ticketId: 'tkt-1',
            repositoryId: 'repo-1',
            blockedBy: [],
            attemptsCount: 2,
            lastAttempt: {
              n: 2,
              status: 'verified',
              verdict: 'passed',
              commitSha: 'abcdef1234567890',
              startedAt: ts('2026-05-08T10:00:00.000Z'),
              finishedAt: ts('2026-05-08T10:00:05.000Z'),
            },
          },
        ],
        blockers: [{ taskId: 'task-2', name: 'stuck', reason: 'blocked-status', detail: 'human stop' }],
        staleTasks: [
          {
            taskId: 'task-2',
            name: 'stuck',
            lastSignalAt: ts('2026-05-07T10:00:00.000Z'),
            hoursSinceSignal: 25,
          },
        ],
        dependencyCycles: [['task-x', 'task-y']],
        decisions: [
          {
            chainId: 'chain-1',
            at: ts('2026-05-08T11:00:00.000Z'),
            message: 'picked option B',
            meta: { taskId: 'task-99' },
          },
        ],
        runs: [
          {
            chainId: 'run-1',
            flowId: 'implement',
            startedAt: ts('2026-05-08T10:00:00.000Z'),
            finishedAt: ts('2026-05-08T10:00:05.000Z'),
            outcome: 'completed',
            stepsCompleted: 5,
            stepsFailed: 0,
          },
        ],
      };

      const expected = [
        '# Sprint progress — demo',
        '',
        '## Status',
        '- id: sprint-1',
        '- status: blocked',
        '- 1/3 done · 1 in progress · 1 blocked',
        '- activated: 2026-05-08T10:00:00.000Z · review: 2026-05-09T10:00:00.000Z',
        '',
        '## Branch & PR',
        '- branch: feature/x (expected feature/x, actual feature/y)',
        '- pull request: https://example.com/pr/1',
        '',
        '## Tickets',
        '- tkt-1 — fix login [JIRA-42]',
        '  status: approved',
        '',
        '## Tasks',
        '| # | name | status | attempts | last verdict | commit |',
        '|---|------|--------|----------|--------------|--------|',
        '| 1 | wire form | done | 2 | passed | abcdef1 |',
        '',
        '## Blockers',
        '- ✗ stuck — human stop',
        '',
        '## Stale tasks',
        '- ⚠ stuck — 25h since last signal',
        '',
        '## Dependency cycles',
        '- task-x → task-y',
        '',
        '## Decisions',
        '- 2026-05-08T11:00:00.000Z [task-99] picked option B',
        '',
        '## Recent runs',
        '- run-1 · implement · completed · 5s · 5/5 steps',
        '',
      ].join('\n');

      expect(renderProgressMarkdown(state)).toBe(expected);
    });
  });
});
