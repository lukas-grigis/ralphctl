import { describe, expect, it } from 'vitest';

import type { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import type { Task } from '@src/domain/entity/task.ts';
import { buildPlanTree, type PlanNode } from '@src/application/chain/plan-tree.ts';
import type { LoopIteration, StepStart, TraceEntry } from '@src/application/chain/trace.ts';
import {
  type CreateImplementFlowOpts,
  planImplementWaves,
  type RepoExecConfig,
} from '@src/application/flows/implement/flow.ts';
import type { ImplementDeps } from '@src/application/flows/implement/deps.ts';
import { buildAttemptReadConfig } from '@src/application/flows/implement/leaves/attempt-body.ts';
import { createParallelImplementElement } from '@src/application/flows/implement/parallel-element.ts';
import { buildWaveBranches, createFoldQueue } from '@src/application/flows/implement/wave-branch.ts';
import { flattenStepRows, projectFlowProgress } from '@src/application/ui/tui/runtime/flow-progress.ts';

import { absolutePath, FIXED_REPOSITORY_ID, makeDraftSprint, makeTodoTask, slug } from '@tests/fixtures/domain.ts';

/** The step display over the REAL parallel implement plan (construction-only, inert deps). */

const deps = (): ImplementDeps =>
  ({
    config: {
      harness: {
        maxTurns: 5,
        maxAttempts: 3,
        rateLimitRetries: 0,
        plateauThreshold: 2,
        escalateOnPlateau: false,
        escalationMap: {},
      },
    },
  }) as unknown as ImplementDeps;

const opts = (todoTasks: readonly Task[]): CreateImplementFlowOpts => ({
  sprintId: makeDraftSprint().id,
  todoTasks,
  repositories: new Map<RepositoryId, RepoExecConfig>([
    [FIXED_REPOSITORY_ID, { path: absolutePath('/repos/main'), name: 'main', verifyScript: 'v', setupScript: 's' }],
  ]),
  progressFile: absolutePath('/sprints/s1/progress.md'),
  sprintDir: absolutePath('/sprints/s1'),
  generatorProviderId: 'claude-code',
  generatorModel: 'claude-opus-4-8',
  evaluatorProviderId: 'claude-code',
  evaluatorModel: 'claude-opus-4-8',
  memoryRoot: absolutePath('/data/memory'),
  projectId: 'proj-1',
  projectSlug: slug('proj-1'),
});

const parallelPlan = (tasks: readonly Task[]): PlanNode => {
  const d = deps();
  const o = opts(tasks);
  const plan = planImplementWaves(d, o);
  if (!plan.ok) throw new Error('unschedulable fixture');
  const element = createParallelImplementElement(plan.value, {
    fileLocker: d.fileLocker,
    locksRoot: absolutePath('/locks'),
    eventBus: d.eventBus,
    maxConcurrency: 2,
    flowId: 'implement',
    sessionId: () => 'sub',
    buildWaves: () =>
      buildWaveBranches(
        { implement: d, eventBus: d.eventBus, foldQueue: createFoldQueue() },
        o,
        plan.value.waves,
        buildAttemptReadConfig(d.config.harness)
      ),
  });
  return buildPlanTree(element);
};

const walk = (node: PlanNode, ancestors: readonly PlanNode[] = []): Array<[PlanNode, readonly PlanNode[]]> => [
  [node, ancestors],
  ...node.children.flatMap((c) => walk(c, [...ancestors, node])),
];

/** The leaf named `<prefix>-<taskId>` and the loop iterations (all 1) that enclose it. */
const leafIn = (plan: PlanNode, prefix: string, taskId: string): { name: string; iterations: LoopIteration[] } => {
  const found = walk(plan).find(([n]) => n.kind === 'leaf' && n.name === `${prefix}-${taskId}`);
  if (found === undefined) throw new Error(`no leaf ${prefix}-${taskId}`);
  const [leaf, ancestors] = found;
  return {
    name: leaf.name,
    iterations: ancestors.filter((a) => a.kind === 'loop').map((a) => ({ loop: a.name, n: 1 })),
  };
};

const prologueEntries = (plan: PlanNode): TraceEntry[] =>
  walk(plan.children[0]!)
    .filter(([n]) => n.kind === 'leaf')
    .map(([n]) => ({ elementName: n.name, status: 'completed', durationMs: 1 }));

const inFlight = (...leaves: Array<{ name: string; iterations: LoopIteration[] }>): Map<string, StepStart> =>
  new Map(leaves.map((l): [string, StepStart] => [l.name, { elementName: l.name, iterations: l.iterations }]));

describe('flow progress — parallel implement plan', () => {
  const tasks = [makeTodoTask({ name: 'First task', order: 1 }), makeTodoTask({ name: 'Second task', order: 2 })];
  const [a, b] = tasks.map((t) => String(t.id)) as [string, string];
  const plan = parallelPlan(tasks);

  it('keeps each merge step inside its task and locates the running task leaf', () => {
    const progress = projectFlowProgress({
      plan,
      trace: prologueEntries(plan),
      inFlight: inFlight(leafIn(plan, 'generator', a)),
      running: true,
      awaiting: false,
    });

    const runTasks = progress.spine.find((v) => v.label === 'Run tasks');
    expect(runTasks).toMatchObject({ status: 'running', progress: { done: 0, total: 2 }, children: [] });
    expect(progress.currentStep).toStrictEqual({ label: 'Generate', workItemId: a });
    // The running task expands; its merge step is its own last row.
    expect(flattenStepRows([progress.workItems.get(a)!]).map((v) => v.label)).toContain('Merge to sprint branch');
    expect(progress.workItems.get(b)?.leafCount).toBe(progress.workItems.get(a)?.leafCount);
  });

  it('leaves an untouched earlier task pending while a later one runs', () => {
    const progress = projectFlowProgress({
      plan,
      trace: prologueEntries(plan),
      inFlight: inFlight(leafIn(plan, 'generator', b)),
      running: true,
      awaiting: false,
    });

    expect(progress.workItems.get(a)?.status).toBe('pending');
    expect(progress.workItems.get(b)?.status).toBe('running');
    expect(progress.currentStep).toStrictEqual({ label: 'Generate', workItemId: b });
  });
});
