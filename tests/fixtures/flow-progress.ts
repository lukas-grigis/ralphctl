/** A small task-flow plan (Prepare leaf, per-task subtrees, Finish) usable as a PlanNode, an Element or a projection. */

import type { Element } from '@src/application/chain/element.ts';
import type { PlanNode } from '@src/application/chain/plan-tree.ts';
import type { StepStart, Trace } from '@src/application/chain/trace.ts';
import { projectFlowProgress, type FlowProgress } from '@src/application/ui/tui/runtime/flow-progress.ts';

const leafNode = (name: string, label: string): PlanNode => ({
  name,
  label,
  kind: 'leaf',
  internal: false,
  children: [],
});

export const taskFlowPlan = (taskIds: readonly string[]): PlanNode => ({
  name: 'implement',
  kind: 'sequential',
  internal: false,
  children: [
    leafNode('load-tasks', 'Load tasks'),
    {
      name: 'implement-tasks',
      label: 'Run tasks',
      kind: 'sequential',
      internal: false,
      children: taskIds.map((id): PlanNode => ({
        name: `task-${id}`,
        label: `Task ${id}`,
        kind: 'sequential',
        internal: false,
        workItem: { kind: 'task', id },
        children: [leafNode(`generator-${id}`, 'Generate'), leafNode(`commit-task-${id}`, 'Commit')],
      })),
    },
    leafNode('transition-sprint-to-review', 'Move sprint to review'),
  ],
});

/** Inert element mirroring a plan — enough for `buildPlanTree` through `runner.element`. */
export const planToElement = (node: PlanNode): Element<unknown> => ({
  name: node.name,
  ...(node.label !== undefined ? { label: node.label } : {}),
  kind: node.kind,
  ...(node.workItem !== undefined ? { display: { workItem: node.workItem } } : {}),
  children: node.children.map(planToElement),
  execute: () => Promise.reject(new Error('plan-only element')),
});

export const taskFlowProgress = (
  taskIds: readonly string[],
  opts: { trace?: Trace; inFlight?: readonly string[]; running?: boolean } = {}
): FlowProgress =>
  projectFlowProgress({
    plan: taskFlowPlan(taskIds),
    trace: opts.trace ?? [],
    inFlight: new Map((opts.inFlight ?? []).map((n): [string, StepStart] => [n, { elementName: n }])),
    running: opts.running ?? true,
    awaiting: false,
  });
