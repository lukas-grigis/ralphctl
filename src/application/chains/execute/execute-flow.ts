/**
 * `createExecuteFlow` — chain definition for sprint task execution.
 *
 * Steps (happy path):
 *
 *   load-sprint → assert-active → load-tasks → assert-tasks-not-empty →
 *     check-scripts-sprint-start → link-skills →
 *     execute-tasks (Parallel of per-task chains) → unlink-skills
 *
 * The `execute-tasks` step is a `Parallel` whose children are
 * `createPerTaskFlow(deps, { task, sprint })` instances. Concurrency
 * defaults to 4 and `failureMode` is `'collect-all'` so one failing
 * task doesn't abort the others — the per-task chain is responsible
 * for capturing its own outcome.
 *
 * SIMPLIFICATION: feedback is **not** embedded inside this chain. The
 * brief calls this out — once `execute-tasks` settles, the CLI/TUI is
 * responsible for prompting the user for feedback and starting a
 * separate `createFeedbackFlow` session if they provide any. Embedding
 * feedback here would couple the executor to user-input timing.
 *
 * `auto-activate` is not a step here. The brief allowed an "active OR
 * auto-activate" branch, but conditionals are not a kernel primitive —
 * the caller (CLI / TUI) is responsible for activating a draft sprint
 * before launching execution. The chain enforces `assert-active` so
 * misuse fails loudly.
 */
import { Result } from 'typescript-result';

import type { Sprint } from '../../../domain/entities/sprint.ts';
import type { Task } from '../../../domain/entities/task.ts';
import { InvalidStateError } from '../../../domain/errors/invalid-state-error.ts';
import type { Element } from '../../../kernel/chain/element.ts';
import { Leaf } from '../../../kernel/chain/leaf.ts';
import { Parallel } from '../../../kernel/chain/parallel.ts';
import { Sequential } from '../../../kernel/chain/sequential.ts';
import type { AbsolutePath } from '../../../domain/values/absolute-path.ts';
import type { SprintId } from '../../../domain/values/sprint-id.ts';
import type { ChainSharedDeps } from '../chain-deps.ts';
import { linkSkillsLeaf } from '../leaves/link-skills.ts';
import { loadSprintLeaf } from '../leaves/load-sprint.ts';
import { loadTasksLeaf } from '../leaves/load-tasks.ts';
import { unlinkSkillsLeaf } from '../leaves/unlink-skills.ts';
import { createPerTaskFlow, type PerTaskCtx } from './per-task-flow.ts';

export interface ExecuteCtx {
  readonly sprintId: SprintId;
  readonly cwd: AbsolutePath;
  /** Sprint branch name. Empty string disables branch verification per task. */
  readonly expectedBranch: string;
  /** Resolved check script (per-repo lookup happens at the caller). */
  readonly checkScript?: string;
  readonly sprint?: Sprint;
  readonly tasks?: readonly Task[];
}

export interface CreateExecuteFlowOpts {
  readonly sprintId: SprintId;
  readonly cwd: AbsolutePath;
  /** Sprint branch (empty string opts out of branch enforcement). */
  readonly expectedBranch: string;
  /** Pre-loaded task list — used to size the Parallel children at construction time. */
  readonly tasks: readonly Task[];
  /** Pre-loaded sprint — passed to each per-task chain. */
  readonly sprint: Sprint;
  /** Concurrency cap. Defaults to 4. */
  readonly concurrency?: number;
  /** Optional check script for the post-task gate (uniform across tasks for now). */
  readonly checkScript?: string;
}

export function createExecuteFlow(
  deps: Pick<
    ChainSharedDeps,
    | 'sprintRepo'
    | 'taskRepo'
    | 'aiSession'
    | 'prompts'
    | 'signalParser'
    | 'external'
    | 'logger'
    | 'skillsLinker'
    | 'liveConfig'
  >,
  opts: CreateExecuteFlowOpts
): Element<ExecuteCtx> {
  const concurrency = opts.concurrency ?? 4;

  const perTaskChildren: Element<PerTaskCtx>[] = opts.tasks.map((task) =>
    createPerTaskFlow(deps, { task, sprint: opts.sprint })
  );

  // Bridge: the outer chain's ExecuteCtx is wider than each per-task
  // chain's PerTaskCtx. Wrap each per-task chain in a leaf-shaped
  // adapter that projects `ExecuteCtx → PerTaskCtx`, runs the inner
  // chain, and folds the result back into ExecuteCtx (we discard the
  // per-task ctx; the outer flow only needs to know the per-task
  // chain's overall success/failure).
  const adaptedChildren: Element<ExecuteCtx>[] = opts.tasks.map((task, idx) =>
    bridgePerTaskChain(task, perTaskChildren[idx], opts)
  );

  const executeTasksStep = new Parallel<ExecuteCtx>('execute-tasks', adaptedChildren, {
    concurrency,
    failureMode: 'collect-all',
    reduce: (childCtxs) => {
      // Each child returns the same ExecuteCtx shape. Merge: keep the
      // freshest ctx fields by preferring the last child's snapshot —
      // the outer state is otherwise identical (per-task chains write
      // their own state, not the executor's).
      const last = childCtxs[childCtxs.length - 1];
      return last ?? ({} as ExecuteCtx);
    },
  });

  return new Sequential<ExecuteCtx>('execute', [
    loadSprintLeaf<ExecuteCtx>({ sprintRepo: deps.sprintRepo }),
    assertActiveLeaf(),
    loadTasksLeaf<ExecuteCtx>({ taskRepo: deps.taskRepo }),
    assertTasksNotEmptyLeaf(),
    checkScriptsSprintStartLeaf(deps),
    linkSkillsLeaf<ExecuteCtx>({ skillsLinker: deps.skillsLinker }),
    executeTasksStep,
    unlinkSkillsLeaf<ExecuteCtx>({ skillsLinker: deps.skillsLinker }),
  ]);
}

/**
 * Wrap a per-task chain so it consumes the outer `ExecuteCtx` shape.
 * The bridge:
 *  - projects ctx → PerTaskCtx,
 *  - runs the per-task chain to completion,
 *  - rolls per-task trace entries up into the outer chain's trace
 *    (already handled by the kernel's Element.execute contract — we
 *    just return the inner result),
 *  - returns the original outer ctx unchanged on success.
 *
 * NOTE: we use a `Leaf` here rather than calling `inner.execute` from
 * inside a use case, because Leaf is the canonical adapter and gives
 * us trace entries for free. The leaf invokes the inner chain
 * directly via `inner.execute(...)`, which is allowed at the chain
 * layer (only use cases are barred from doing this).
 */
function bridgePerTaskChain(
  task: Task,
  inner: Element<PerTaskCtx> | undefined,
  opts: CreateExecuteFlowOpts
): Element<ExecuteCtx> {
  if (!inner) {
    throw new Error(`bridgePerTaskChain: no inner chain for task ${task.id}`);
  }
  return new Leaf<ExecuteCtx, ExecuteCtx, ExecuteCtx>(`task-${task.id}`, {
    useCase: {
      async execute(input) {
        const innerCtx: PerTaskCtx = {
          sprintId: input.sprintId,
          sprint: opts.sprint,
          task,
          cwd: task.projectPath,
          expectedBranch: input.expectedBranch,
          ...(input.checkScript !== undefined ? { checkScript: input.checkScript } : {}),
        };
        const innerResult = await inner.execute(innerCtx);
        if (!innerResult.ok) {
          // Per-task failure surfaces, but the surrounding Parallel
          // is `collect-all` so siblings continue.
          return Result.error(innerResult.error.error);
        }
        return Result.ok(input);
      },
    },
    input: (ctx) => ctx,
    output: (ctx) => ctx,
  });
}

function assertActiveLeaf(): Element<ExecuteCtx> {
  return new Leaf<ExecuteCtx, { readonly sprint: Sprint }, void>('assert-active', {
    useCase: {
      async execute(input) {
        if (input.sprint.status !== 'active') {
          return Promise.resolve(
            Result.error(
              new InvalidStateError({
                entity: 'sprint',
                currentState: input.sprint.status,
                attemptedAction: 'execute',
                message: 'execute requires an active sprint (run sprint start first)',
              })
            )
          );
        }
        return Promise.resolve(Result.ok(undefined));
      },
    },
    input: (ctx) => {
      if (!ctx.sprint) throw new Error('assert-active: ctx.sprint must be loaded first');
      return { sprint: ctx.sprint };
    },
    output: (ctx) => ctx,
  });
}

function assertTasksNotEmptyLeaf(): Element<ExecuteCtx> {
  return new Leaf<ExecuteCtx, { readonly tasks: readonly Task[] }, void>('assert-tasks-not-empty', {
    useCase: {
      async execute(input) {
        if (input.tasks.length === 0) {
          return Promise.resolve(
            Result.error(
              new InvalidStateError({
                entity: 'sprint',
                currentState: 'no-tasks',
                attemptedAction: 'execute',
                message: 'no tasks to execute — run sprint plan first',
              })
            )
          );
        }
        return Promise.resolve(Result.ok(undefined));
      },
    },
    input: (ctx) => ({ tasks: ctx.tasks ?? [] }),
    output: (ctx) => ctx,
  });
}

/**
 * Sprint-start check execution — runs the project check script once
 * before any tasks fan out, surfacing a hard failure if the baseline
 * environment is broken. Skipped when no check script is configured.
 */
function checkScriptsSprintStartLeaf(deps: Pick<ChainSharedDeps, 'external'>): Element<ExecuteCtx> {
  return new Leaf<ExecuteCtx, { readonly cwd: AbsolutePath; readonly checkScript?: string }, void>(
    'check-scripts-sprint-start',
    {
      useCase: {
        async execute(input) {
          if (input.checkScript === undefined || input.checkScript.length === 0) {
            return Promise.resolve(Result.ok(undefined));
          }
          const r = await deps.external.runCheckScript(input.cwd, input.checkScript, 'sprint-start');
          if (!r.passed) {
            return Result.error(
              new InvalidStateError({
                entity: 'sprint',
                currentState: 'check-failed',
                attemptedAction: 'execute',
                message: 'sprint-start check script failed',
              })
            );
          }
          return Result.ok(undefined);
        },
      },
      input: (ctx) => ({
        cwd: ctx.cwd,
        ...(ctx.checkScript !== undefined ? { checkScript: ctx.checkScript } : {}),
      }),
      output: (ctx) => ctx,
    }
  );
}
