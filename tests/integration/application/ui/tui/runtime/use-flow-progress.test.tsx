/** The descriptor keeps its identity while trace and live mutate in place; the hook must still re-project. */

import React from 'react';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { describe, expect, it } from 'vitest';
import type { PlanNode } from '@src/application/chain/plan-tree.ts';
import type { TraceEntry } from '@src/application/chain/trace.ts';
import type { SessionDescriptor, SessionLive } from '@src/application/ui/tui/runtime/session-manager.ts';
import { useFlowProgress } from '@src/application/ui/tui/runtime/use-flow-progress.ts';
import { flattenStepRows } from '@src/application/ui/tui/runtime/flow-progress.ts';
import { runTaskKey, type TaskVerdicts } from '@src/application/ui/tui/runtime/use-task-round-verdicts.ts';

const leafNode = (name: string): PlanNode => ({ name, label: name, kind: 'leaf', internal: false, children: [] });
const plan: PlanNode = {
  name: 'root',
  kind: 'sequential',
  internal: false,
  children: [leafNode('one'), leafNode('two')],
};

const Probe = ({ descriptor }: { readonly descriptor: SessionDescriptor }): React.JSX.Element => {
  const progress = useFlowProgress({ descriptor, awaiting: false });
  return <Text>{progress?.spine.map((v) => `${v.label}:${v.status}`).join(' ')}</Text>;
};

describe('useFlowProgress', () => {
  it('advances on live.version and trace growth without a new descriptor', () => {
    const trace: TraceEntry[] = [];
    const live: SessionLive = { inFlight: new Map(), version: 0 };
    const descriptor = {
      id: 's',
      flowId: 'plan',
      title: 't',
      status: 'running',
      startedAt: 0,
      trace,
      planTree: plan,
      live,
    } as SessionDescriptor;
    const r = render(<Probe descriptor={descriptor} />);
    live.inFlight.set('one', { elementName: 'one' });
    live.version += 1;
    r.rerender(<Probe descriptor={descriptor} />);
    expect(r.lastFrame()).toContain('one:running two:pending');
    live.inFlight.clear();
    trace.push({ elementName: 'one', status: 'completed', durationMs: 1 });
    live.inFlight.set('two', { elementName: 'two' });
    live.version += 1;
    r.rerender(<Probe descriptor={descriptor} />);
    expect(r.lastFrame()).toContain('one:completed two:running');
    r.unmount();
  });

  it('returns undefined without a plan tree', () => {
    const descriptor = {
      id: 's',
      flowId: 'x',
      title: 't',
      status: 'running',
      startedAt: 0,
      trace: [],
    } as SessionDescriptor;
    const r = render(<Probe descriptor={descriptor} />);
    expect(r.lastFrame()).toBe('');
    r.unmount();
  });

  it("reads the verdicts of the descriptor's own run", () => {
    const loopNode = (name: string, children: PlanNode[]): PlanNode => ({
      name,
      label: name,
      kind: 'loop',
      internal: false,
      children,
    });
    const taskPlan: PlanNode = {
      name: 'root',
      kind: 'sequential',
      internal: false,
      children: [
        {
          name: 'task-t',
          label: 'Task t',
          kind: 'sequential',
          internal: false,
          workItem: { kind: 'task', id: 't' },
          children: [loopNode('Attempt', [loopNode('Round', [leafNode('gen')])])],
        },
      ],
    };
    const at = (round: number) => [
      { loop: 'Attempt', n: 1 },
      { loop: 'Round', n: round },
    ];
    const descriptor = {
      id: 'run-2',
      flowId: 'implement',
      title: 't',
      status: 'running',
      startedAt: 0,
      trace: [{ elementName: 'gen', status: 'completed', durationMs: 1, iterations: at(1) }],
      planTree: taskPlan,
      live: { inFlight: new Map([['gen', { elementName: 'gen', iterations: at(2) }]]), version: 1 },
    } as SessionDescriptor;
    const verdict = (status: 'passed' | 'failed'): TaskVerdicts =>
      new Map([[1, new Map([[1, { status, dimensions: [] }]])]]);
    const verdicts = new Map([
      [runTaskKey('run-1', 't'), verdict('failed')],
      [runTaskKey('run-2', 't'), verdict('passed')],
    ]);
    const VerdictProbe = (): React.JSX.Element => {
      const progress = useFlowProgress({ descriptor, awaiting: false, verdicts });
      const rows = flattenStepRows([...(progress?.workItems.values() ?? [])]);
      return (
        <Text>{rows.map((v) => `${v.label}#${String(v.iteration?.n)}:${v.verdict?.status ?? '-'}`).join(' ')}</Text>
      );
    };
    const r = render(<VerdictProbe />);
    expect(r.lastFrame()).toContain('Round#1:passed');
    r.unmount();
  });
});
