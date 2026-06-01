import { describe, expect, it } from 'vitest';

import type { Task } from '@src/domain/entity/task.ts';
import type { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import type { Element } from '@src/application/chain/element.ts';
import { guard } from '@src/application/chain/build/guard.ts';
import { sequential } from '@src/application/chain/build/sequential.ts';
import { loadSprintExecutionLeaf } from '@src/application/flows/_shared/sprint/load-execution.ts';
import { loadTasksLeaf } from '@src/application/flows/_shared/task/load.ts';
import { saveTasksLeaf } from '@src/application/flows/_shared/task/save.ts';
import { loadAndAssertSprintSubChain } from '@src/application/flows/_shared/sprint/load-and-assert-sprint.ts';
import { activateSprintLeaf } from '@src/application/flows/implement/leaves/activate-sprint.ts';
import { appendJournalSeparatorLeaf } from '@src/application/flows/_shared/progress/append-journal-separator.ts';
import { createPerTaskSubchain } from '@src/application/flows/implement/leaves/per-task-subchain.ts';
import { type DirtyTreePolicy } from '@src/application/flows/implement/leaves/preflight-task.ts';
import { resolveBranchLeaf } from '@src/application/flows/implement/leaves/resolve-branch.ts';
import { resolveRepoOrThrow } from '@src/application/flows/implement/leaves/resolve-repo.ts';
import { setupScriptRunnerLeaf } from '@src/application/flows/implement/leaves/setup-script-runner.ts';
import {
  buildPreflightLeaves,
  buildWorkingTreeCleanLeaves,
  setupRepoEntriesForTasks,
  uniqueRepoCwdsForTasks,
} from '@src/application/flows/implement/leaves/sprint-repo-plan.ts';
import { transitionSprintToReviewLeaf } from '@src/application/flows/implement/leaves/transition-sprint-to-review.ts';
import { withRepoLock } from '@src/application/flows/_shared/with-repo-lock.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import type { ImplementDeps } from '@src/application/flows/implement/deps.ts';
import {
  buildImplementEpilogue,
  buildImplementPrologue,
  type CreateImplementFlowOpts,
  createImplementFlow,
  IMPLEMENT_TASK_TERMINAL_LEAF,
  planImplementWaves,
  type RepoExecConfig,
} from '@src/application/flows/implement/flow.ts';

import { absolutePath, FIXED_REPOSITORY_ID, makeTodoTask } from '@tests/fixtures/domain.ts';

/**
 * A serialisable snapshot of an element tree: name + optional label + recursively-snapshotted
 * children. Walking `Element.children` (never executing) is exactly what the TUI does to render the
 * upfront plan, so this captures the OBSERVABLE chain shape — the thing the serial-shape fence must
 * keep byte-for-byte stable through the prologue/epilogue extraction. Names, labels, child count,
 * and nesting are all compared.
 */
interface ShapeNode {
  readonly name: string;
  readonly label?: string;
  readonly children?: readonly ShapeNode[];
}

const snapshot = <TCtx>(element: Element<TCtx>): ShapeNode => {
  const kids = element.children;
  return {
    name: element.name,
    ...(element.label !== undefined ? { label: element.label } : {}),
    ...(kids !== undefined ? { children: kids.map((c) => snapshot(c)) } : {}),
  };
};

const names = (node: ShapeNode): readonly string[] => [node.name, ...(node.children ?? []).flatMap((c) => names(c))];

const findByName = (node: ShapeNode, target: string): ShapeNode | undefined => {
  if (node.name === target) return node;
  for (const c of node.children ?? []) {
    const hit = findByName(c, target);
    if (hit !== undefined) return hit;
  }
  return undefined;
};

// ── Stub deps + opts ────────────────────────────────────────────────────────────────────
// The flow + segment builders only CONSTRUCT the element tree in these tests — no leaf ever
// executes — so integration ports can be inert stubs. The cast is sound: every factory captures
// its deps in a closure read lazily inside `execute`, which these tests never call. The one field
// read EAGERLY at construction is `config.harness.{maxTurns,plateauThreshold,...}` (the gen-eval
// loop bakes the turn budget into the element), so the stub supplies a real harness config.
const stubDeps = (): ImplementDeps =>
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

const makeOpts = (todoTasks: readonly Task[]): CreateImplementFlowOpts => {
  const repositories = new Map<RepositoryId, RepoExecConfig>([
    [FIXED_REPOSITORY_ID, { path: absolutePath('/repos/main'), name: 'main-repo', verifyScript: 'verify' }],
  ]);
  return {
    sprintId: makeTodoTask().ticketId as never, // unused at construction; placeholder shape only
    todoTasks,
    repositories,
    progressFile: absolutePath('/sprints/s1/progress.md'),
    sprintDir: absolutePath('/sprints/s1'),
    generatorProviderId: 'claude-code',
    generatorModel: 'claude-opus-4-8',
    evaluatorProviderId: 'openai-codex',
    evaluatorModel: 'gpt-5.5',
    memoryRoot: absolutePath('/data/memory'),
    projectId: 'proj-1',
  };
};

/**
 * The pre-refactor serial chain shape, reconstructed inline from the exact same leaf factories the flow
 * used to call directly (a flat `implement-locked` list wrapped in `with-repo-lock`). The central
 * safety claim is that the prologue/epilogue extraction did NOT change this shape; asserting the
 * live `createImplementFlow` equals this independent reconstruction proves it byte-for-byte without
 * coupling the test to every leaf's exact name string. If a future edit drifts the serial structure,
 * this reference and the live flow diverge and the assertion fails.
 *
 * This mirrors `flow.ts` as it stood before the refactor: prologue leaves inline, then `implement-tasks`,
 * then epilogue leaves inline — no `implement-prologue` / `implement-epilogue` wrappers.
 */
const reconstructPreRefactorSerialFlow = (
  deps: ImplementDeps,
  opts: CreateImplementFlowOpts
): Element<ImplementCtx> => {
  const readConfig = (): Promise<{
    readonly maxTurns: number;
    readonly escalateOnPlateau: boolean;
    readonly escalationMap: Readonly<Record<string, string>>;
  }> =>
    Promise.resolve({
      maxTurns: deps.config.harness.maxTurns,
      escalateOnPlateau: deps.config.harness.escalateOnPlateau,
      escalationMap: deps.config.harness.escalationMap,
    });

  const uniqueRepoCwds = uniqueRepoCwdsForTasks(opts.repositories, opts.todoTasks);
  const setupRepoEntries = setupRepoEntriesForTasks(opts.repositories, opts.todoTasks);

  const perTaskChains = opts.todoTasks.map((task) =>
    createPerTaskSubchain(
      deps,
      {
        sprintDir: opts.sprintDir,
        progressFile: opts.progressFile,
        terminalLeafName: IMPLEMENT_TASK_TERMINAL_LEAF,
        generator: {
          providerId: opts.generatorProviderId,
          model: opts.generatorModel,
          ...(opts.generatorEffort !== undefined ? { effort: opts.generatorEffort } : {}),
        },
        evaluator: {
          providerId: opts.evaluatorProviderId,
          model: opts.evaluatorModel,
          ...(opts.evaluatorEffort !== undefined ? { effort: opts.evaluatorEffort } : {}),
        },
        memoryRoot: opts.memoryRoot,
        projectId: opts.projectId,
      },
      task,
      resolveRepoOrThrow(opts.repositories, task),
      readConfig
    )
  );

  const dirtyTreePolicy: DirtyTreePolicy = opts.dirtyTreePolicy ?? 'prompt';
  const preflightLeaves = buildPreflightLeaves(
    { gitRunner: deps.gitRunner, interactive: deps.interactive, clock: deps.clock, logger: deps.logger },
    uniqueRepoCwds,
    dirtyTreePolicy
  );
  const workingTreeCleanLeaves = buildWorkingTreeCleanLeaves(
    { gitRunner: deps.gitRunner, logger: deps.logger },
    uniqueRepoCwds
  );

  const inner = sequential<ImplementCtx>('implement-locked', [
    loadAndAssertSprintSubChain<ImplementCtx>({ sprintRepo: deps.sprintRepo }, ['planned', 'active']),
    activateSprintLeaf({ sprintRepo: deps.sprintRepo, clock: deps.clock, logger: deps.logger }),
    loadSprintExecutionLeaf<ImplementCtx>({ sprintExecutionRepo: deps.sprintExecutionRepo }),
    loadTasksLeaf<ImplementCtx>({ taskRepo: deps.taskRepo }),
    resolveBranchLeaf(
      {
        gitRunner: deps.gitRunner,
        sprintExecutionRepo: deps.sprintExecutionRepo,
        interactive: deps.interactive,
        logger: deps.logger,
      },
      { cwds: uniqueRepoCwds }
    ),
    sequential<ImplementCtx>('working-tree-clean-checks', workingTreeCleanLeaves),
    appendJournalSeparatorLeaf<ImplementCtx>(
      { appendFile: deps.appendFile, clock: deps.clock, logger: deps.logger },
      { progressFile: opts.progressFile, status: 'activated', name: 'progress-journal-activate' }
    ),
    setupScriptRunnerLeaf(
      {
        shellScriptRunner: deps.shellScriptRunner,
        clock: deps.clock,
        eventBus: deps.eventBus,
        sprintExecutionRepo: deps.sprintExecutionRepo,
        logger: deps.logger,
      },
      { repos: setupRepoEntries, sprintDir: opts.sprintDir }
    ),
    sequential<ImplementCtx>('preflight-tasks', preflightLeaves),
    sequential<ImplementCtx>('implement-tasks', perTaskChains),
    saveTasksLeaf<ImplementCtx>({ taskRepo: deps.taskRepo }),
    guard<ImplementCtx>(
      'transition-sprint-to-review-when-settled',
      (ctx) => {
        const tasks = ctx.tasks ?? [];
        const someDone = tasks.some((t) => t.status === 'done');
        const noneRunnable = !tasks.some((t) => t.status === 'todo' || t.status === 'in_progress');
        return someDone && noneRunnable;
      },
      sequential<ImplementCtx>('transition-to-review-and-journal', [
        transitionSprintToReviewLeaf({ sprintRepo: deps.sprintRepo, clock: deps.clock, logger: deps.logger }),
        appendJournalSeparatorLeaf<ImplementCtx>(
          { appendFile: deps.appendFile, clock: deps.clock, logger: deps.logger },
          { progressFile: opts.progressFile, status: 'review', name: 'progress-journal-review' }
        ),
      ])
    ),
  ]);

  return sequential<ImplementCtx>('implement', [
    withRepoLock(
      { fileLocker: deps.fileLocker, locksRoot: deps.locksRoot, worktreePath: opts.sprintDir, eventBus: deps.eventBus },
      inner
    ),
  ]);
};

describe('createImplementFlow — serial chain shape (serial-shape byte-for-byte fence)', () => {
  it('matches the pre-refactor serial tree byte-for-byte (the central safety claim)', () => {
    const task = makeTodoTask({ name: 'do-work' });
    const opts = makeOpts([task]);

    const live = snapshot(createImplementFlow(stubDeps(), opts));
    const reference = snapshot(reconstructPreRefactorSerialFlow(stubDeps(), opts));

    expect(live).toStrictEqual(reference);
  });

  it('matches the pre-refactor serial tree byte-for-byte for a multi-task sprint', () => {
    const t1 = makeTodoTask({ name: 't1', order: 1 });
    const t2 = makeTodoTask({ name: 't2', order: 2 });
    const opts = makeOpts([t1, t2]);

    const live = snapshot(createImplementFlow(stubDeps(), opts));
    const reference = snapshot(reconstructPreRefactorSerialFlow(stubDeps(), opts));

    expect(live).toStrictEqual(reference);
  });

  it('keeps the lock wrapper outside a single flat implement-locked body', () => {
    const opts = makeOpts([makeTodoTask({ name: 'do-work' })]);
    const shape = snapshot(createImplementFlow(stubDeps(), opts));

    // The top node is `implement`; its only child wraps a single `implement-locked` sequential.
    expect(shape.name).toBe('implement');
    expect(shape.children?.length).toBe(1);
    const lock = shape.children?.[0];
    expect(lock?.name).toBe('with-repo-lock(implement-locked)');
    expect(lock?.children?.length).toBe(1);
    expect(lock?.children?.[0]?.name).toBe('implement-locked');
  });

  it('does NOT leak the implement-prologue / implement-epilogue wrapper names into the serial tree', () => {
    const opts = makeOpts([makeTodoTask({ name: 'do-work' })]);
    const allNames = names(snapshot(createImplementFlow(stubDeps(), opts)));

    expect(allNames).not.toContain('implement-prologue');
    expect(allNames).not.toContain('implement-epilogue');
    expect(allNames).toContain('implement-locked');
    expect(allNames).toContain('implement-tasks');
  });

  it('is the serial element (never the parallel orchestrator) — the meta-run caller stays serial', () => {
    // `createImplementFlow` is what BOTH the `maxParallelTasks === 1` launcher path AND the meta-run
    // composer (`createRunFlow`) build. The parallel orchestrator is a DIFFERENT element named
    // `implement-parallel`, reached only via the `> 1` launcher dispatch — never here. This fence
    // proves the meta-run caller (and the serial path) can never accidentally pick up the parallel
    // worktree-fan-out element.
    const opts = makeOpts([makeTodoTask({ name: 'do-work' })]);
    const shape = snapshot(createImplementFlow(stubDeps(), opts));

    expect(shape.name).toBe('implement');
    expect(names(shape)).not.toContain('implement-parallel');
  });

  it('fans out one task-<id> sub-chain per todo task, in order', () => {
    const t1 = makeTodoTask({ name: 't1', order: 1 });
    const t2 = makeTodoTask({ name: 't2', order: 2 });
    const implementTasks = findByName(snapshot(createImplementFlow(stubDeps(), makeOpts([t1, t2]))), 'implement-tasks');

    expect(implementTasks?.children?.map((c) => c.name)).toStrictEqual([
      `task-${String(t1.id)}`,
      `task-${String(t2.id)}`,
    ]);
  });
});

describe('buildImplementPrologue / buildImplementEpilogue', () => {
  it('prologue produces exactly the leaves spliced inline BEFORE implement-tasks in the serial flow', () => {
    const opts = makeOpts([makeTodoTask({ name: 'do-work' })]);

    const prologue = buildImplementPrologue(stubDeps(), opts);
    expect(prologue.name).toBe('implement-prologue');
    const prologueChildren = (prologue.children ?? []).map((c) => snapshot(c));

    const locked = findByName(snapshot(createImplementFlow(stubDeps(), opts)), 'implement-locked');
    const lockedChildren = locked?.children ?? [];
    const idx = lockedChildren.findIndex((c) => c.name === 'implement-tasks');
    const inlinePrologue = lockedChildren.slice(0, idx);

    expect(prologueChildren).toStrictEqual(inlinePrologue);
  });

  it('epilogue produces exactly the leaves spliced inline AFTER implement-tasks in the serial flow', () => {
    const opts = makeOpts([makeTodoTask({ name: 'do-work' })]);

    const epilogue = buildImplementEpilogue(stubDeps(), opts);
    expect(epilogue.name).toBe('implement-epilogue');
    const epilogueChildren = (epilogue.children ?? []).map((c) => snapshot(c));

    const locked = findByName(snapshot(createImplementFlow(stubDeps(), opts)), 'implement-locked');
    const lockedChildren = locked?.children ?? [];
    const idx = lockedChildren.findIndex((c) => c.name === 'implement-tasks');
    const inlineEpilogue = lockedChildren.slice(idx + 1);

    expect(epilogueChildren).toStrictEqual(inlineEpilogue);
  });
});

describe('planImplementWaves', () => {
  it('returns the prologue, epilogue, lockKey, and dependency-scheduled waves', () => {
    const task = makeTodoTask({ name: 'do-work' });
    const opts = makeOpts([task]);

    const plan = planImplementWaves(stubDeps(), opts);

    expect(plan.prologue.name).toBe('implement-prologue');
    expect(plan.epilogue.name).toBe('implement-epilogue');
    expect(plan.lockKey).toBe(opts.sprintDir);
    expect(plan.waves.map((w) => w.map((t) => String(t.id)))).toStrictEqual([[String(task.id)]]);
  });

  it('its prologue/epilogue segments equal the standalone segment builders', () => {
    const opts = makeOpts([makeTodoTask({ name: 'do-work' })]);
    const plan = planImplementWaves(stubDeps(), opts);

    expect(snapshot(plan.prologue)).toStrictEqual(snapshot(buildImplementPrologue(stubDeps(), opts)));
    expect(snapshot(plan.epilogue)).toStrictEqual(snapshot(buildImplementEpilogue(stubDeps(), opts)));
  });

  it('schedules tasks into dependency layers (diamond → 3 waves)', () => {
    const a = makeTodoTask({ name: 'a', order: 1 });
    const b = makeTodoTask({ name: 'b', order: 2, dependsOn: [a.id] });
    const c = makeTodoTask({ name: 'c', order: 3, dependsOn: [a.id] });
    const d = makeTodoTask({ name: 'd', order: 4, dependsOn: [b.id, c.id] });

    const plan = planImplementWaves(stubDeps(), makeOpts([a, b, c, d]));

    expect(plan.waves.map((w) => w.map((t) => String(t.id)))).toStrictEqual([
      [String(a.id)],
      [String(b.id), String(c.id)],
      [String(d.id)],
    ]);
  });

  it('fails closed with an empty wave list when the task graph is unschedulable (no throw)', () => {
    const x = makeTodoTask({ name: 'x', order: 1 });
    const selfEdged: Task = { ...x, dependsOn: [x.id] }; // self-edge → scheduleIntoWaves errors
    const plan = planImplementWaves(stubDeps(), makeOpts([selfEdged]));

    expect(plan.waves).toStrictEqual([]);
    // The segments + lock key are still produced — only the schedule is empty.
    expect(plan.prologue.name).toBe('implement-prologue');
    expect(plan.epilogue.name).toBe('implement-epilogue');
    expect(plan.lockKey).toBe(makeOpts([selfEdged]).sprintDir);
  });
});
