import { describe, expect, it } from 'vitest';

import type { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { Element } from '@src/application/chain/element.ts';
import { buildPlanTree, type PlanNode } from '@src/application/chain/plan-tree.ts';
import {
  type CreateImplementFlowOpts,
  createImplementFlow,
  planImplementWaves,
  type RepoExecConfig,
} from '@src/application/flows/implement/flow.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import type { ImplementDeps } from '@src/application/flows/implement/deps.ts';
import { buildAttemptReadConfig } from '@src/application/flows/implement/leaves/attempt-body.ts';
import { createParallelImplementElement } from '@src/application/flows/implement/parallel-element.ts';
import { buildWaveBranches, createFoldQueue } from '@src/application/flows/implement/wave-branch.ts';
import { createPlanFlow } from '@src/application/flows/plan/flow.ts';
import type { PlanDeps } from '@src/application/flows/plan/deps.ts';
import { createRefineFlow } from '@src/application/flows/refine/flow.ts';
import type { RefineDeps } from '@src/application/flows/refine/deps.ts';
import { createReviewFlow } from '@src/application/flows/review/flow.ts';
import type { ReviewDeps } from '@src/application/flows/review/deps.ts';
import { SprintId } from '@src/domain/value/id/sprint-id.ts';

import {
  absolutePath,
  FIXED_PROJECT_ID,
  FIXED_REPOSITORY_ID,
  makeDraftSprint,
  makePendingTicket,
  makeTodoTask,
  slug,
} from '@tests/fixtures/domain.ts';

/**
 * Copy fence for the step display: every flow's plan tree must name its steps for humans. Built
 * construction-only with inert deps (same rationale as the per-flow flow-shape fences).
 */

const REPO_NAME = 'main-repo';
const MAX_LABEL = 24;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const PATH = /(^|\s)[~.]?\/\S/;

const walk = (node: PlanNode): readonly PlanNode[] => [node, ...node.children.flatMap((c) => walk(c))];
const leaves = (node: PlanNode): readonly PlanNode[] => walk(node).filter((n) => n.children.length === 0);

/** The work-item roots carry user content (task name / ticket title) as their label. */
const userContentLabels = (node: PlanNode): ReadonlySet<PlanNode> =>
  new Set(walk(node).filter((n) => n.workItem !== undefined));

const implementDeps = (): ImplementDeps =>
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

const implementOpts = (todoTasks: readonly Task[]): CreateImplementFlowOpts => ({
  sprintId: makeDraftSprint().id,
  todoTasks,
  repositories: new Map<RepositoryId, RepoExecConfig>([
    [
      FIXED_REPOSITORY_ID,
      { path: absolutePath(`/repos/${REPO_NAME}`), name: REPO_NAME, verifyScript: 'verify', setupScript: 'setup' },
    ],
  ]),
  progressFile: absolutePath('/sprints/s1/progress.md'),
  sprintDir: absolutePath('/sprints/s1'),
  generatorProviderId: 'claude-code',
  generatorModel: 'claude-opus-4-8',
  evaluatorProviderId: 'openai-codex',
  evaluatorModel: 'gpt-5.5',
  memoryRoot: absolutePath('/data/memory'),
  projectId: 'proj-1',
  projectSlug: slug('proj-1'),
});

const twoTasks = (): readonly Task[] => [
  makeTodoTask({ name: 'First task', order: 1 }),
  makeTodoTask({ name: 'Second task', order: 2 }),
];

const serialImplement = (): Element<ImplementCtx> => createImplementFlow(implementDeps(), implementOpts(twoTasks()));

const parallelImplement = (): Element<ImplementCtx> => {
  const deps = implementDeps();
  const opts = implementOpts(twoTasks());
  const plan = planImplementWaves(deps, opts);
  if (!plan.ok) throw new Error('unschedulable fixture');
  const branchDeps = { implement: deps, eventBus: deps.eventBus, foldQueue: createFoldQueue() };
  return createParallelImplementElement(plan.value, {
    fileLocker: deps.fileLocker,
    locksRoot: absolutePath('/locks'),
    eventBus: deps.eventBus,
    maxConcurrency: 2,
    flowId: 'implement',
    sessionId: () => 'sub',
    buildWaves: () =>
      buildWaveBranches(branchDeps, opts, plan.value.waves, buildAttemptReadConfig(deps.config.harness)),
  });
};

const plan = (): Element<unknown> =>
  createPlanFlow({} as unknown as PlanDeps, {
    sprintId: makeDraftSprint().id,
    projectId: FIXED_PROJECT_ID,
    providerId: 'claude-code',
    model: 'claude-opus-4-8',
    maxAttempts: 3,
    planRoot: absolutePath('/sprints/s1/plan'),
  }) as Element<unknown>;

const refine = (): Element<unknown> =>
  createRefineFlow({} as unknown as RefineDeps, {
    sprintId: makeDraftSprint().id,
    pendingTickets: [makePendingTicket({ title: 'Ticket one' }), makePendingTicket({ title: 'Ticket two' })],
    providerId: 'claude-code',
    model: 'claude-opus-4-8',
    refinementRoot: absolutePath('/sprints/s1/refinement'),
  }) as Element<unknown>;

const review = (): Element<unknown> =>
  createReviewFlow(
    { distill: { deps: {}, opts: {} } } as unknown as ReviewDeps,
    {
      sprintId: SprintId.generate(),
      sprintDir: absolutePath('/sprints/s1'),
      reviewRoot: absolutePath('/sprints/s1/review'),
      commitCwd: absolutePath(`/repos/${REPO_NAME}`),
      additionalRoots: [absolutePath(`/repos/${REPO_NAME}`)],
      repositoriesBlock: `- ${REPO_NAME}`,
      feedbackFile: absolutePath('/sprints/s1/feedback.md'),
      progressFile: absolutePath('/sprints/s1/progress.md'),
    } as never
  ) as Element<unknown>;

const FLOWS: ReadonlyArray<readonly [string, () => Element<unknown>]> = [
  ['implement (serial)', () => serialImplement() as Element<unknown>],
  ['implement (parallel)', () => parallelImplement() as Element<unknown>],
  ['plan', plan],
  ['refine', refine],
  ['review', review],
];

describe.each(FLOWS)('%s plan tree — step labels', (_flow, build) => {
  const tree = buildPlanTree(build());

  it('has unique element names', () => {
    const all = walk(tree).map((n) => n.name);
    const dupes = all.filter((n, i) => all.indexOf(n) !== i);
    expect(dupes).toStrictEqual([]);
  });

  it('labels every leaf', () => {
    expect(
      leaves(tree)
        .filter((n) => n.label === undefined)
        .map((n) => n.name)
    ).toStrictEqual([]);
  });

  it('keeps step labels short, with no ids or paths', () => {
    const userContent = userContentLabels(tree);
    const offending = walk(tree)
      .filter((n) => n.label !== undefined && !userContent.has(n))
      .map((n) => n.label!)
      .filter((label) => {
        const bare = label.endsWith(` · ${REPO_NAME}`) ? label.slice(0, -` · ${REPO_NAME}`.length) : label;
        return bare.length > MAX_LABEL || UUID.test(label) || PATH.test(label);
      });
    expect(offending).toStrictEqual([]);
  });
});

describe('work-item roots', () => {
  it('serial implement: each task-<id> carries its task work item and the task name', () => {
    const tasks = twoTasks();
    const tree = buildPlanTree(createImplementFlow(implementDeps(), implementOpts(tasks)));
    const items = walk(tree).filter((n) => n.workItem !== undefined);
    expect(items.map((n) => [n.name, n.label, n.workItem])).toStrictEqual(
      tasks.map((t) => [`task-${String(t.id)}`, t.name, { kind: 'task', id: String(t.id) }])
    );
  });

  it('parallel implement: the per-task subchains under implement-waves carry their task work items', () => {
    const tree = buildPlanTree(parallelImplement());
    expect(tree.children.map((c) => c.name)).toStrictEqual([
      'implement-prologue',
      'implement-waves',
      'implement-epilogue',
    ]);
    const waves = tree.children[1]!;
    expect(walk(waves).filter((n) => n.workItem?.kind === 'task')).toHaveLength(2);
  });

  it('refine: each refine-<id> carries its ticket work item and the ticket title', () => {
    const tree = buildPlanTree(refine());
    const items = walk(tree).filter((n) => n.workItem !== undefined);
    expect(items.map((n) => [n.label, n.workItem?.kind])).toStrictEqual([
      ['Ticket one', 'ticket'],
      ['Ticket two', 'ticket'],
    ]);
    for (const item of items) expect(item.name).toBe(`refine-${item.workItem!.id}`);
  });
});
