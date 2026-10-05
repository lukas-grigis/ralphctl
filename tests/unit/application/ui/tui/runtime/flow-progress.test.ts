import { describe, expect, it } from 'vitest';
import type { WorkItemRef } from '@src/application/chain/element.ts';
import type { PlanNode } from '@src/application/chain/plan-tree.ts';
import type { LoopIteration, StepStart, TraceEntry } from '@src/application/chain/trace.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import {
  flattenStepRows,
  projectFlowProgress,
  type FlowProgress,
  type RoundVerdictLookup,
  type StepView,
} from '@src/application/ui/tui/runtime/flow-progress.ts';

interface NodeOpts {
  label?: string;
  internal?: boolean;
  workItem?: WorkItemRef;
  max?: number;
}
const node = (kind: PlanNode['kind'], name: string, children: PlanNode[], o: NodeOpts = {}): PlanNode => ({
  name,
  kind,
  internal: o.internal === true,
  children,
  ...(o.label !== undefined ? { label: o.label } : {}),
  ...(o.workItem !== undefined ? { workItem: o.workItem } : {}),
  ...(o.max !== undefined ? { maxIterations: o.max } : {}),
});
const lf = (name: string, o?: NodeOpts): PlanNode => node('leaf', name, [], o);
const seq = (name: string, children: PlanNode[], o?: NodeOpts): PlanNode => node('sequential', name, children, o);
const grd = (name: string, body: PlanNode, o?: NodeOpts): PlanNode => node('guard', name, [body], o);
const lp = (name: string, children: PlanNode[], o?: NodeOpts): PlanNode => node('loop', name, children, o);

const iter = (...pairs: Array<[string, number]>): LoopIteration[] => pairs.map(([loop, n]) => ({ loop, n }));
const ent = (
  name: string,
  status: TraceEntry['status'] = 'completed',
  iterations?: LoopIteration[],
  durationMs = 10
): TraceEntry => ({
  elementName: name,
  status,
  durationMs,
  ...(iterations !== undefined ? { iterations } : {}),
});
const start = (name: string, iterations?: LoopIteration[]): [string, StepStart] => [
  name,
  { elementName: name, ...(iterations !== undefined ? { iterations } : {}) },
];

interface Run {
  trace?: TraceEntry[];
  inFlight?: Array<[string, StepStart]>;
  running?: boolean;
  awaiting?: boolean;
  verdicts?: RoundVerdictLookup;
}
const project = (plan: PlanNode, r: Run = {}): FlowProgress =>
  projectFlowProgress({
    plan,
    trace: r.trace ?? [],
    inFlight: new Map(r.inFlight ?? []),
    running: r.running ?? true,
    awaiting: r.awaiting ?? false,
    ...(r.verdicts !== undefined ? { verdicts: r.verdicts } : {}),
  });

const labels = (views: readonly StepView[]): string[] => views.map((v) => v.label);
const byLabel = (p: FlowProgress, label: string): StepView | undefined =>
  flattenStepRows(p.spine).find((v) => v.label === label);
const T = (id: string): WorkItemRef => ({ kind: 'task', id });

/** implement-shaped: Prepare / Run tasks (task a, b) / Finish. */
const implementPlan = (): PlanNode =>
  seq('implement', [
    seq('implement-locked', [
      seq('implement-prologue', [lf('load-tasks', { internal: true, label: 'Load tasks' })], { label: 'Prepare' }),
      seq(
        'implement-tasks',
        ['a', 'b'].map((id) =>
          seq(
            `task-${id}`,
            [
              lf(`gate-${id}`, { internal: true, label: 'Check dependencies' }),
              lp(
                `attempts-${id}`,
                [
                  lf(`baseline-${id}`, { label: 'Verify baseline' }),
                  lp(
                    `rounds-${id}`,
                    [
                      lf(`generator-${id}`, { label: 'Generate' }),
                      grd(`eval-guard-${id}`, lf(`evaluator-${id}`, { label: 'Evaluate' })),
                      lf(`stamp-${id}`, { internal: true, label: 'Record session' }),
                    ],
                    { label: 'Round', max: 5 }
                  ),
                  lf(`verify-${id}`, { label: 'Verify' }),
                  lf(`commit-${id}`, { label: 'Commit' }),
                ],
                { label: 'Attempt', max: 3 }
              ),
              lf(`journal-${id}`, { internal: true, label: 'Update journal' }),
            ],
            { label: `Task ${id}`, workItem: T(id) }
          )
        ),
        { label: 'Run tasks' }
      ),
      seq(
        'implement-epilogue',
        [lf('save-tasks', { internal: true }), lf('to-review', { label: 'Move sprint to review' })],
        {
          label: 'Finish',
        }
      ),
    ]),
  ]);

describe('projectFlowProgress', () => {
  it('R0: resolves entries to nodes by name at any depth, composites and leaves alike', () => {
    const plan = seq('root', [
      seq('outer', [seq('inner', [lf('deep', { label: 'Deep' })], { label: 'Inner' })], { label: 'Outer' }),
    ]);
    const p = project(plan, { trace: [ent('deep')], running: false });
    expect(byLabel(p, 'Outer')?.status).toBe('completed');
    expect(p.spine).toHaveLength(1);
  });

  it('R1: a loop leaf matches only the entry of its own iteration', () => {
    const plan = seq('root', [lp('loop', [lf('body', { label: 'Body' })], { label: 'Round', max: 3 })]);
    const p = project(plan, {
      trace: [ent('body', 'completed', iter(['loop', 1])), ent('body', 'failed', iter(['loop', 2]))],
      running: false,
    });
    const rows = p.spine;
    expect(rows.map((r) => [r.iteration?.n, r.status])).toEqual([
      [1, 'completed'],
      [2, 'failed'],
    ]);
  });

  it('R2: iteration 2 shows its own pending body and iteration 1 as a history row', () => {
    const plan = seq('root', [
      lp('loop', [lf('gen', { label: 'Generate' }), lf('eval', { label: 'Evaluate' })], { label: 'Round', max: 5 }),
    ]);
    const p = project(plan, {
      trace: [ent('gen', 'completed', iter(['loop', 1])), ent('eval', 'completed', iter(['loop', 1]))],
      inFlight: [start('gen', iter(['loop', 2]))],
    });
    expect(p.spine.map((r) => [r.iteration, r.status])).toEqual([
      [{ n: 1, max: 5 }, 'completed'],
      [{ n: 2, max: 5 }, 'running'],
    ]);
    expect(p.spine[0]?.children).toEqual([]);
    expect(p.spine[1]?.inline?.map((v) => [v.label, v.status])).toEqual([
      ['Generate', 'running'],
      ['Evaluate', 'pending'],
    ]);
  });

  it('R3: a composite skip marks leaves without entries skipped, not pending', () => {
    const plan = seq('root', [
      lf('work', { label: 'Work' }),
      grd('save-guard', seq('save-body', [lf('a', { label: 'A' }), lf('b', { label: 'B' })]), { label: 'Save' }),
      lf('last', { label: 'Last' }),
    ]);
    const p = project(plan, { trace: [ent('work'), ent('save-guard', 'skipped'), ent('last')], running: false });
    expect(byLabel(p, 'Save')?.status).toBe('skipped');
    expect(p.spine.at(-1)?.status).toBe('completed');
  });

  it('R4: the Run tasks row is running while a per-task leaf is in flight', () => {
    const p = project(implementPlan(), {
      trace: [ent('load-tasks')],
      inFlight: [start('baseline-a', iter(['attempts-a', 1]))],
    });
    expect(p.spine.map((v) => [v.label, v.status])).toEqual([
      ['Prepare', 'completed'],
      ['Run tasks', 'running'],
      ['Finish', 'pending'],
    ]);
    expect(p.activeSpineIndex).toBe(1);
  });

  it('R4: without start data the first untouched leaf after the last entry is guessed running', () => {
    const plan = seq('root', [
      lf('one', { label: 'One' }),
      lf('two', { label: 'Two' }),
      lf('three', { label: 'Three' }),
    ]);
    const p = project(plan, { trace: [ent('one')] });
    expect(p.spine.map((v) => v.status)).toEqual(['completed', 'running', 'pending']);
    expect(project(plan, { trace: [ent('one')], running: false }).spine.map((v) => v.status)).toEqual([
      'completed',
      'pending',
      'pending',
    ]);
  });

  it('R4: several leaves in flight at once are all running (parallel work items)', () => {
    const p = project(implementPlan(), {
      trace: [ent('load-tasks')],
      inFlight: [
        start('generator-a', iter(['attempts-a', 1], ['rounds-a', 1])),
        start('baseline-b', iter(['attempts-b', 1])),
      ],
    });
    expect(p.workItems.get('a')?.status).toBe('running');
    expect(p.workItems.get('b')?.status).toBe('running');
    expect(p.currentStep?.workItemId).toBe('a');
  });

  it('R5: leaves before a touched sibling are inferred completed when their entries are evicted', () => {
    const plan = seq('root', [
      lf('head', { label: 'Head' }),
      lf('mid', { label: 'Mid' }),
      lf('tail', { label: 'Tail' }),
    ]);
    const p = project(plan, { trace: [ent('tail')], running: false });
    expect(p.spine.map((v) => v.status)).toEqual(['completed', 'completed', 'completed']);
  });

  it('R6: composite status aggregation and duration sum', () => {
    const mk = (trace: TraceEntry[], running = false): StepView | undefined => {
      const plan = seq('root', [seq('grp', [lf('a', { label: 'A' }), lf('b', { label: 'B' })], { label: 'Group' })]);
      return project(plan, { trace, running }).spine[0];
    };
    expect(mk([ent('a'), ent('b', 'failed')])?.status).toBe('failed');
    expect(mk([ent('a'), ent('b', 'aborted')])?.status).toBe('aborted');
    expect(mk([ent('a', 'completed', undefined, 5), ent('b', 'completed', undefined, 7)])).toMatchObject({
      status: 'completed',
      durationMs: 12,
      leafCount: 2,
    });
    expect(mk([ent('a', 'skipped'), ent('b', 'skipped')])?.status).toBe('skipped');
    expect(mk([])?.status).toBe('pending');
  });

  it('R7: internal steps hide unless failed; unlabelled composites are transparent; deep skips hide', () => {
    const plan = seq('root', [
      lf('show', { label: 'Show' }),
      seq('wrap', [lf('lifted', { label: 'Lifted' })]),
      seq('grp', [lf('hid', { internal: true, label: 'Hidden' }), lf('late', { internal: true, label: 'Late fail' })], {
        label: 'Group',
      }),
      lf('after', { label: 'After' }),
    ]);
    const ok = project(plan, {
      trace: [ent('show'), ent('lifted'), ent('hid'), ent('late'), ent('after')],
      running: false,
    });
    expect(labels(ok.spine)).toEqual(['Show', 'Lifted', 'Group', 'After']);
    expect(ok.spine[2]?.children).toEqual([]);
    const failed = project(plan, {
      trace: [
        ent('show'),
        ent('lifted'),
        ent('hid'),
        { ...ent('late', 'failed'), error: new ValidationError({ message: 'boom' } as never) },
      ],
      running: false,
    });
    expect(flattenStepRows(failed.spine).map((v) => v.label)).toContain('Late fail');
    const skipped = project(
      seq('root', [lf('one', { label: 'One' }), seq('g', [lf('x', { label: 'X' })], { label: 'G' })]),
      {
        trace: [ent('one'), ent('g', 'skipped')],
        running: false,
      }
    );
    expect(skipped.spine[1]).toMatchObject({ label: 'G', status: 'skipped' });
    const nested = project(
      seq('root', [
        seq('outer', [lf('one', { label: 'One' }), grd('g', lf('x', { label: 'X' }), { label: 'G' })], {
          label: 'Outer',
        }),
      ]),
      {
        trace: [ent('one'), ent('g', 'skipped')],
        running: true,
      }
    );
    expect(flattenStepRows(nested.spine).map((v) => v.label)).not.toContain('G');
  });

  it('R8: leading and trailing internal runs fold into Prepare and Finish; the middle stays hidden', () => {
    const plan = seq('plan', [
      lf('load-a', { internal: true, label: 'Load a' }),
      lf('load-b', { internal: true, label: 'Load b' }),
      lf('call', { label: 'Plan with AI' }),
      lf('mid', { internal: true, label: 'Mid' }),
      lf('check', { label: 'Check plan' }),
      lf('save', { internal: true, label: 'Save' }),
    ]);
    const p = project(plan, { trace: [ent('load-a'), ent('load-b'), ent('call')], inFlight: [start('mid')] });
    expect(labels(p.spine)).toEqual(['Prepare', 'Plan with AI', 'Check plan', 'Finish']);
    expect(p.spine[0]).toMatchObject({ status: 'completed', leafCount: 2 });
    expect(p.spine[3]?.status).toBe('pending');
  });

  it('R8: single-child unlabelled wrappers unwrap to the spine; an empty spine falls back to the raw one', () => {
    const wrapped = seq('implement', [
      seq('lock', [seq('locked', [lf('a', { label: 'A' }), lf('b', { label: 'B' })])]),
    ]);
    expect(labels(project(wrapped, { running: false }).spine)).toEqual(['A', 'B']);
    const allInternal = seq('flow', [lf('a', { internal: true, label: 'A' }), lf('b', { internal: true, label: 'B' })]);
    expect(project(allInternal, { running: false }).spine.length).toBeGreaterThan(0);
  });

  it('R9: a hidden in-flight leaf puts its label as the tail on the nearest visible row', () => {
    const p = project(implementPlan(), {
      trace: [ent('load-tasks')],
      inFlight: [start('stamp-a', iter(['attempts-a', 1], ['rounds-a', 1]))],
    });
    const round = flattenStepRows(p.workItems.get('a')?.children ?? []).find((v) => v.label === 'Round');
    expect(round).toMatchObject({ status: 'running', tail: 'Record session' });
    expect(p.currentStep?.label).toBe('Round · Record session');
  });

  it('R10: task fan-out shows progress, never expands, and sets hasTaskWorkItems', () => {
    const p = project(implementPlan(), {
      trace: [ent('load-tasks'), ...['gate-a', 'journal-a'].map((n) => ent(n))],
      inFlight: [start('baseline-b', iter(['attempts-b', 1]))],
    });
    // Task a fully done.
    const done = project(implementPlan(), {
      trace: [
        ent('load-tasks'),
        ent('gate-a'),
        ent('baseline-a', 'completed', iter(['attempts-a', 1])),
        ent('generator-a', 'completed', iter(['attempts-a', 1], ['rounds-a', 1])),
        ent('evaluator-a', 'completed', iter(['attempts-a', 1], ['rounds-a', 1])),
        ent('stamp-a', 'completed', iter(['attempts-a', 1], ['rounds-a', 1])),
        ent('verify-a', 'completed', iter(['attempts-a', 1])),
        ent('commit-a', 'completed', iter(['attempts-a', 1])),
        ent('journal-a'),
      ],
      inFlight: [start('baseline-b', iter(['attempts-b', 1]))],
    });
    const tasks = done.spine[1];
    expect(tasks?.progress).toEqual({ done: 1, total: 2 });
    expect(tasks?.children).toEqual([]);
    expect(done.hasTaskWorkItems).toBe(true);
    expect(p.workItems.has('b')).toBe(true);
  });

  it('R10: ticket fan-out expands one row per ticket and is not a task work item', () => {
    const plan = seq('refine', [
      seq(
        'refine-tickets',
        ['t1', 't2'].map((id) =>
          seq(
            `refine-${id}`,
            [lf(`fetch-${id}`, { label: 'Fetch issue' }), lf(`ai-${id}`, { label: 'Refine with AI' })],
            {
              label: `Ticket ${id}`,
              workItem: { kind: 'ticket', id },
            }
          )
        ),
        { label: 'Refine tickets' }
      ),
    ]);
    const p = project(plan, { trace: [ent('fetch-t1')], inFlight: [start('ai-t1')] });
    expect(p.hasTaskWorkItems).toBe(false);
    expect(p.spine[0]?.progress).toEqual({ done: 0, total: 2 });
    expect(labels(p.spine[0]?.children ?? [])).toEqual(['Ticket t1', 'Ticket t2']);
    expect(p.spine[0]?.children[0]?.children.map((c) => c.label)).toEqual(['Fetch issue', 'Refine with AI']);
    expect(p.spine[0]?.children[1]?.children).toEqual([]);
  });

  it('R11: the active path expands, completed groups collapse to a count and duration', () => {
    const plan = seq('root', [
      seq('done', [lf('a', { label: 'A' }), lf('b', { label: 'B' })], { label: 'Done group' }),
      seq('live', [lf('c', { label: 'C' }), lf('d', { label: 'D' })], { label: 'Live group' }),
    ]);
    const p = project(plan, {
      trace: [ent('a', 'completed', undefined, 3), ent('b', 'completed', undefined, 4), ent('c')],
      inFlight: [start('d')],
    });
    expect(p.spine[0]).toMatchObject({ status: 'completed', durationMs: 7, leafCount: 2, children: [] });
    expect(labels(p.spine[1]?.children ?? [])).toEqual(['C', 'D']);
  });

  it('R12: running iteration reads n/max; verdicts attach to finished rounds; failed verdict keeps a completed row', () => {
    const verdicts: RoundVerdictLookup = ({ taskId, attemptN, roundN }) =>
      taskId === 'a' && attemptN === 1 && roundN === 1
        ? { status: 'failed', dimensions: ['correctness'], headline: 'wrong string' }
        : undefined;
    const sc = (r: number): LoopIteration[] => iter(['attempts-a', 1], ['rounds-a', r]);
    const p = project(implementPlan(), {
      trace: [
        ent('load-tasks'),
        ent('gate-a'),
        ent('baseline-a', 'completed', iter(['attempts-a', 1])),
        ent('generator-a', 'completed', sc(1)),
        ent('evaluator-a', 'completed', sc(1)),
        ent('stamp-a', 'completed', sc(1)),
      ],
      inFlight: [start('generator-a', sc(2))],
      verdicts,
    });
    const attempt = p.workItems.get('a')?.children.find((v) => v.label === 'Attempt');
    expect(attempt?.iteration).toEqual({ n: 1, max: 3 });
    const rounds = attempt?.children.filter((v) => v.label === 'Round') ?? [];
    expect(rounds.map((r) => [r.iteration?.n, r.status, r.verdict?.status])).toEqual([
      [1, 'completed', 'failed'],
      [2, 'running', undefined],
    ]);
    expect(rounds[1]?.iteration).toEqual({ n: 2, max: 5 });
    expect(rounds[0]?.verdict?.dimensions).toEqual(['correctness']);
  });

  it('R12: more than three finished iterations keep the last two behind an earlier marker', () => {
    const plan = seq('root', [lp('loop', [lf('body', { label: 'Body' })], { label: 'Round', max: 9 })]);
    const trace = [1, 2, 3, 4, 5].map((n) => ent('body', 'completed', iter(['loop', n])));
    const p = project(plan, { trace, inFlight: [start('body', iter(['loop', 6]))] });
    expect(p.spine.map((v) => v.earlier ?? v.iteration?.n)).toEqual([3, 4, 5, 6]);
  });

  it('R13: awaiting turns the running leaf and its ancestors into waiting, with no running status left', () => {
    const plan = seq('root', [
      lf('load', { label: 'Load' }),
      seq('g', [lf('ask', { label: 'Approve plan' })], { label: 'Gate' }),
    ]);
    const p = project(plan, { trace: [ent('load')], inFlight: [start('ask')], awaiting: true });
    expect(p.spine.map((v) => v.status)).toEqual(['completed', 'waiting']);
    expect(flattenStepRows(p.spine).some((v) => v.status === 'running')).toBe(false);
  });

  it('R14: currentStep names the deepest running row; failure names the first failed leaf and its work item', () => {
    const running = project(implementPlan(), {
      trace: [ent('load-tasks'), ent('gate-b')],
      inFlight: [start('verify-b', iter(['attempts-b', 1]))],
    });
    expect(running.currentStep).toEqual({ label: 'Verify', workItemId: 'b' });
    const err = new ValidationError({ message: 'git commit failed' } as never);
    const failed = project(implementPlan(), {
      trace: [ent('load-tasks'), ent('gate-b'), { ...ent('commit-b', 'failed', iter(['attempts-b', 1])), error: err }],
      running: false,
    });
    expect(failed.failure).toMatchObject({ label: 'Commit', workItemLabel: 'Task b' });
    expect(failed.failure?.message).toContain('git commit failed');
    expect(failed.workItems.get('b')?.status).toBe('failed');
  });

  it('R14: a task fan-out row with its own non-task rows still locates the running task leaf', () => {
    const plan = seq('implement', [
      seq(
        'tasks',
        [
          seq('task-a', [lf('gen-a', { label: 'Generate' })], { label: 'Task a', workItem: T('a') }),
          lf('tally', { label: 'Tally' }),
        ],
        { label: 'Run tasks' }
      ),
    ]);
    const p = project(plan, { trace: [ent('tally')], inFlight: [start('gen-a')] });
    expect(labels(p.spine[0]!.children)).toEqual(['Tally']);
    expect(p.currentStep).toEqual({ label: 'Generate', workItemId: 'a' });
  });

  it('keeps hasTaskWorkItems false for flows without work items', () => {
    const p = project(seq('plan', [lf('a', { label: 'A' })]));
    expect(p.hasTaskWorkItems).toBe(false);
    expect(p.workItems.size).toBe(0);
  });
});
