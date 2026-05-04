/**
 * `createExecuteFlow` — chain definition for sprint task execution.
 *
 * Steps (happy path):
 *
 *   load-sprint → assert-active → load-tasks → reset-stale-in-progress →
 *     assert-tasks-not-empty → assert-tasks-blocked-by-resolvable →
 *     assert-tasks-acyclic →
 *     [initialize]:
 *       resolve-branch → dirty-tree-preflight → check-scripts-sprint-start →
 *     link-skills →
 *     execute-tasks (Sequential of topologically-ordered per-task chains) →
 *     unlink-skills → summarise-execution
 *
 * The `execute-tasks` step is a `Sequential` whose children are
 * `createPerTaskFlow(deps, { task, sprint })` instances, ordered via
 * `topologicalReorder` so every task appears AFTER all of its `blockedBy`
 * entries. Tasks already in a terminal status (`done` / `blocked`) are
 * filtered out at construction time so the trace stays focused on work
 * that actually runs.
 *
 * ## Initializer phase (`Sequential('initialize', [...])`)
 *
 * The three SETUP leaves — `resolve-branch`, `dirty-tree-preflight`, and
 * `check-scripts-sprint-start` — are grouped into an inner Sequential named
 * `'initialize'`. This separates CONTRACT validation (the `assert-*` leaves
 * above) from environment SETUP (the initializer) from execution (the
 * per-task fan-out). Because `Sequential` flattens child traces, the
 * `'initialize'` name itself does NOT appear as a trace entry; the three
 * leaf names surface flatly just as they did before. The grouping is purely
 * structural: it makes the chain definition self-documenting and keeps the
 * phase separation explicit for future additions.
 *
 * `link-skills` / `unlink-skills` sit outside the initializer — they form a
 * bracket pair around `execute-tasks` and belong to the execution phase.
 *
 * `resolve-branch` decides the sprint branch BEFORE the dirty-tree
 * preflight runs, so a freshly-created branch is what the user's
 * stash/reset interactions land on. When `sprint.branch` is already
 * set (resume case), the leaf reuses it without prompting. Otherwise
 * the user picks between "keep current", "auto-generate
 * `ralphctl/<sprint-id>`", and "custom name". The chosen branch is
 * persisted on `sprint.branch` and created in every unique repo path
 * across the task list. The resolved value lands on
 * `ctx.expectedBranch`, which the per-task bridge reads — so every
 * per-task chain's `branch-preflight` sees the freshly-resolved value.
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
import { Result } from '@src/domain/result.ts';

import {
  DirtyTreePreflightUseCase,
  type DirtyTreePreflightOutput,
} from '@src/business/usecases/execute/dirty-tree-preflight.ts';
import type { Sprint } from '@src/domain/entities/sprint.ts';
import type { Task } from '@src/domain/entities/task.ts';
import { InvalidStateError } from '@src/domain/errors/invalid-state-error.ts';
import type { Element } from '@src/kernel/chain/element.ts';
import { Leaf } from '@src/kernel/chain/leaf.ts';
import { Sequential } from '@src/kernel/chain/sequential.ts';
import { topologicalReorder } from '@src/kernel/algorithms/dependency-reorder.ts';
import type { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import type { SprintId } from '@src/domain/values/sprint-id.ts';
import type { ChainSharedDeps } from '@src/application/chains/chain-deps.ts';
import { assertActiveLeaf } from '@src/application/chains/leaves/assert-active.ts';
import { linkSkillsLeaf } from '@src/application/chains/leaves/link-skills.ts';
import { loadSprintLeaf } from '@src/application/chains/leaves/load-sprint.ts';
import { loadTasksLeaf } from '@src/application/chains/leaves/load-tasks.ts';
import { unlinkSkillsLeaf } from '@src/application/chains/leaves/unlink-skills.ts';
import { createPerTaskFlow, type PerTaskCtx } from './per-task-flow.ts';

export interface ExecuteCtx {
  readonly sprintId: SprintId;
  readonly cwd: AbsolutePath;
  /**
   * Sprint branch name. Empty string disables branch verification per task.
   *
   * The launcher seeds this (typically with `''` for fresh runs or the
   * value of `sprint.branch` when resuming). The `resolve-branch` leaf
   * may overwrite it after prompting the user. Every downstream step
   * (including the per-task bridge) reads this from the context, NOT
   * from `CreateExecuteFlowOpts.expectedBranch` — so the resolved value
   * propagates correctly.
   */
  readonly expectedBranch: string;
  /** Resolved check script (per-repo lookup happens at the caller). */
  readonly checkScript?: string;
  readonly sprint?: Sprint;
  readonly tasks?: readonly Task[];
  /** Outcome of the dirty-tree pre-flight (set by `dirty-tree-preflight`). */
  readonly dirtyTreeOutcome?: DirtyTreePreflightOutput;
  /**
   * When `true`, the per-task `commit-task` leaf no-ops. Threaded through
   * to every per-task chain via the bridge so the launcher's opt-out
   * propagates across the whole sprint.
   */
  readonly noCommit?: boolean;
}

export interface CreateExecuteFlowOpts {
  readonly sprintId: SprintId;
  readonly cwd: AbsolutePath;
  /**
   * Default seed for `ctx.expectedBranch`. The chain's `resolve-branch`
   * leaf may overwrite the ctx value after prompting; downstream steps
   * always read from `ctx.expectedBranch`, never from this seed.
   */
  readonly expectedBranch: string;
  /**
   * Pre-loaded task list — used to size the Sequential children at
   * construction time. Tasks already in `done` / `blocked` are filtered
   * out before bridging; the remaining tasks are linearised in topological
   * order via `topologicalReorder`.
   */
  readonly tasks: readonly Task[];
  /** Pre-loaded sprint — passed to each per-task chain. */
  readonly sprint: Sprint;
  /** Optional check script for the post-task gate (uniform across tasks for now). */
  readonly checkScript?: string;
  /**
   * Disable the per-task commit. When omitted (or `false`), the per-task
   * chain commits after the evaluator round settles. CLI exposes this
   * via `--no-commit`.
   */
  readonly noCommit?: boolean;
}

export function createExecuteFlow(
  deps: Pick<
    ChainSharedDeps,
    | 'sprintRepo'
    | 'taskRepo'
    | 'aiSession'
    | 'prompts'
    | 'prompt'
    | 'signalParser'
    | 'external'
    | 'logger'
    | 'skillsLinker'
    | 'liveConfig'
    | 'signalBus'
    | 'signalHandler'
    | 'rateLimitCoordinator'
    | 'writeContextFile'
    | 'sessionFolderBuilder'
  >,
  opts: CreateExecuteFlowOpts
): Element<ExecuteCtx> {
  // Filter out tasks already in a terminal state — a resumed sprint may have
  // finished or blocked tasks from a prior run, and there's nothing to do for
  // those. Keeping them out of the Sequential keeps the trace focused on the
  // work that actually runs.
  const runnableTasks = opts.tasks.filter((t) => t.status !== 'done' && t.status !== 'blocked');

  // When a runnable task carries a `blockedBy` edge to a settled task (the
  // resume case), the dep is implicitly satisfied — the prior run already
  // produced its outcome. Drop those edges before sorting so
  // `topologicalReorder` doesn't reject them as `unknown-dep`. References
  // to ids that are NOT in the sprint's task set at all (phantom / stale
  // plan) survive as-is so `assert-tasks-acyclic` surfaces them honestly.
  const settledIds = new Set(
    opts.tasks.filter((t) => t.status === 'done' || t.status === 'blocked').map((t) => String(t.id))
  );

  // Linearise the runnable tasks via Kahn's topological sort. `blockedBy` is
  // the dependency edge; `topologicalReorder` falls back to stable input order
  // among ready nodes so the result is deterministic. Sort errors (cycle /
  // unknown-dep) propagate at runtime via the `assert-tasks-acyclic` leaf so
  // the chain stops cleanly with an InvalidStateError instead of looping.
  const sortResult = topologicalReorder(
    runnableTasks.map((t) => ({
      item: t,
      id: String(t.id),
      blockedBy: t.blockedBy.map(String).filter((id) => !settledIds.has(id)),
    }))
  );
  const orderedTasks: readonly Task[] = sortResult.ok ? sortResult.value : [];

  // Bridge: the outer chain's ExecuteCtx is wider than each per-task
  // chain's PerTaskCtx. Wrap each per-task chain in a leaf-shaped
  // adapter that projects `ExecuteCtx → PerTaskCtx`, runs the inner
  // chain, and folds the result back into ExecuteCtx (we discard the
  // per-task ctx; the outer flow only needs to know the per-task
  // chain's overall success/failure).
  const adaptedChildren: Element<ExecuteCtx>[] = orderedTasks.map((task) =>
    bridgePerTaskChain(task, createPerTaskFlow(deps, { task, sprint: opts.sprint }), opts, deps.taskRepo)
  );

  const executeTasksStep = new Sequential<ExecuteCtx>('execute-tasks', adaptedChildren);

  // Initializer phase: environment SETUP that must succeed before any task
  // runs. Grouped separately from the CONTRACT validation above (assert-*)
  // and from the execution phase (link-skills → execute-tasks).
  const initializeStep = new Sequential<ExecuteCtx>('initialize', [
    resolveBranchLeaf(deps),
    dirtyTreePreflightLeaf(deps, opts),
    checkScriptsSprintStartLeaf(deps),
  ]);

  return new Sequential<ExecuteCtx>('execute', [
    loadSprintLeaf<ExecuteCtx>({ sprintRepo: deps.sprintRepo }),
    assertActiveLeaf<ExecuteCtx>('execute', 'execute requires an active sprint (run sprint start first)'),
    loadTasksLeaf<ExecuteCtx>({ taskRepo: deps.taskRepo }),
    resetStaleInProgressLeaf(deps),
    assertTasksNotEmptyLeaf(),
    assertTasksBlockedByResolvableLeaf(),
    assertTasksAcyclicLeaf(sortResult),
    initializeStep,
    linkSkillsLeaf<ExecuteCtx>({ skillsLinker: deps.skillsLinker }, { phase: 'exec' }),
    executeTasksStep,
    unlinkSkillsLeaf<ExecuteCtx>({ skillsLinker: deps.skillsLinker }),
    summariseExecutionLeaf(deps, opts),
  ]);
}

/**
 * Reset every task left in `in_progress` from a prior interrupted run back
 * to `todo`. Without this, a previous `sprint start` that was killed/escaped
 * after `mark-in-progress` ran but before the task settled leaves phantom
 * `IN PROGRESS` pills on the next launch — the runner hasn't actually
 * spawned an AI session yet, but the task panel reads stale on-disk state
 * via `load-tasks`. Runs after `load-tasks` so the in-memory ctx.tasks list
 * also reflects the reset; downstream steps see fresh `todo` statuses.
 *
 * Pure cleanup — never fails the chain. Repository write errors are logged
 * but the chain continues with the in-memory reset so the user isn't blocked
 * by a transient persistence hiccup.
 */
function resetStaleInProgressLeaf(deps: Pick<ChainSharedDeps, 'taskRepo' | 'logger'>): Element<ExecuteCtx> {
  return new Leaf<ExecuteCtx, { readonly sprintId: SprintId; readonly tasks: readonly Task[] }, readonly Task[]>(
    'reset-stale-in-progress',
    {
      useCase: {
        async execute(input) {
          const stale = input.tasks.filter((t) => t.status === 'in_progress');
          if (stale.length === 0) return Result.ok(input.tasks);
          const next: Task[] = [];
          for (const t of input.tasks) {
            if (t.status !== 'in_progress') {
              next.push(t);
              continue;
            }
            const reset = t.resetToTodo();
            if (!reset.ok) {
              next.push(t);
              continue;
            }
            const saved = await deps.taskRepo.update(input.sprintId, reset.value);
            if (!saved.ok) {
              deps.logger.warn(`reset-stale-in-progress: failed to persist reset for task ${String(t.id)}`, {
                taskId: String(t.id),
                error: saved.error.message,
              });
              next.push(reset.value);
              continue;
            }
            next.push(reset.value);
          }
          deps.logger.info(`reset ${String(stale.length)} stale in-progress task(s) from a prior run`, {
            sprintId: String(input.sprintId),
            count: stale.length,
          });
          return Result.ok(next);
        },
      },
      input: (ctx) => ({ sprintId: ctx.sprintId, tasks: ctx.tasks ?? [] }),
      output: (ctx, tasks) => ({ ...ctx, tasks }),
    }
  );
}

/**
 * Sprint branch resolver. Decides the sprint branch BEFORE the
 * dirty-tree preflight runs so a fresh branch is what gets stashed-onto.
 *
 * Resolution rules:
 *  - When `sprint.branch !== null` (resume case, or pre-seeded by the
 *    launcher via `--branch` / `--branch-name` / saved sprint state):
 *    use it as-is, no prompt, no save, no branch creation. The branch
 *    has already been created on the previous run.
 *  - When `sprint.branch === null`: prompt the user for a strategy:
 *      1. Keep current branch — no enforcement, no creation
 *      2. Auto-generate `ralphctl/<sprint-id>`
 *      3. Custom name (re-prompts on invalid input)
 *    On strategies 2/3, persist via `Sprint.setBranch(...)` and create
 *    the branch in every unique repo path across the task list. A
 *    repo-by-repo failure is hard — the leaf returns `Result.error`
 *    rather than silently skipping repos.
 *
 * Output: writes the resolved branch (or `''` for "keep current") onto
 * `ctx.expectedBranch`. The bridge into per-task chains reads from
 * `ctx.expectedBranch`, so every per-task `branch-preflight` sees the
 * resolved value.
 */
type BranchStrategy = 'keep' | 'auto' | 'custom';

function resolveBranchLeaf(
  deps: Pick<ChainSharedDeps, 'sprintRepo' | 'external' | 'prompt' | 'logger'>
): Element<ExecuteCtx> {
  return new Leaf<
    ExecuteCtx,
    { readonly sprintId: SprintId; readonly sprint: Sprint; readonly tasks: readonly Task[] },
    string
  >('resolve-branch', {
    useCase: {
      async execute(input) {
        // Resume / pre-seed case — the branch is already known. Skip the
        // prompt but still ensure each repo is on it (idempotent —
        // `createAndCheckoutBranch` no-ops when already there, checks
        // out an existing branch, or creates a missing one).
        if (input.sprint.branch !== null) {
          if (input.sprint.branch.length > 0) {
            for (const repoPath of uniqueRepoPaths(input.tasks)) {
              const created = await deps.external.createAndCheckoutBranch(repoPath, input.sprint.branch);
              if (!created.ok) return Result.error(created.error);
            }
          }
          return Result.ok(input.sprint.branch);
        }

        // Fresh run — ask the user.
        const strategy = await deps.prompt.select<BranchStrategy>({
          message: 'Branch strategy?',
          choices: [
            { label: 'Keep current branch (no enforcement)', value: 'keep' },
            {
              label: `Auto-generate (${deps.external.generateBranchName(String(input.sprintId))})`,
              value: 'auto',
            },
            { label: 'Custom name', value: 'custom' },
          ],
          default: 'auto',
        });

        if (strategy === 'keep') {
          return Result.ok('');
        }

        let branchName: string;
        if (strategy === 'auto') {
          branchName = deps.external.generateBranchName(String(input.sprintId));
        } else {
          // Custom — re-prompt until we get a valid branch name.
          branchName = await promptValidBranchName(deps);
        }

        // Persist on the sprint aggregate.
        const transitioned = input.sprint.setBranch(branchName);
        if (!transitioned.ok) return Result.error(transitioned.error);
        const saved = await deps.sprintRepo.save(transitioned.value);
        if (!saved.ok) return Result.error(saved.error);

        // Create the branch in every unique repo path across the tasks.
        for (const repoPath of uniqueRepoPaths(input.tasks)) {
          const created = await deps.external.createAndCheckoutBranch(repoPath, branchName);
          if (!created.ok) return Result.error(created.error);
        }

        deps.logger.info(`sprint branch resolved`, { branch: branchName });
        return Result.ok(branchName);
      },
    },
    input: (ctx) => {
      if (!ctx.sprint) throw new Error('resolve-branch: ctx.sprint must be loaded first');
      return { sprintId: ctx.sprintId, sprint: ctx.sprint, tasks: ctx.tasks ?? [] };
    },
    // Overwrite the ctx's expectedBranch with the resolved value so every
    // downstream step (including the per-task bridge) sees it.
    output: (ctx, expectedBranch) => ({ ...ctx, expectedBranch }),
  });
}

async function promptValidBranchName(deps: Pick<ChainSharedDeps, 'external' | 'prompt'>): Promise<string> {
  // Loop until the user provides a valid branch name. The InputOptions
  // `validate` hook would surface errors inline in the Ink prompt, but
  // we keep the loop explicit here so non-Ink prompt implementations
  // (and tests) get the same behaviour.
  for (;;) {
    const name = await deps.prompt.input({
      message: 'Branch name?',
      validate: (v) => (deps.external.isValidBranchName(v) ? true : `Invalid branch name: ${v}`),
    });
    if (deps.external.isValidBranchName(name)) return name;
  }
}

/**
 * Final milestone leaf — emits a success-level summary log so the live
 * execute view's "Recent events" panel has a clear "all done" line at
 * the end of a run. Reads task statuses fresh via the repository so the
 * counts reflect any per-task transitions that happened during the
 * Sequential fan-out (the outer ctx.tasks snapshot is the pre-run list).
 *
 * Never blocks: persistence read errors fall through to a quieter info
 * log so the chain still settles cleanly.
 */
function summariseExecutionLeaf(
  deps: Pick<ChainSharedDeps, 'taskRepo' | 'logger'>,
  opts: CreateExecuteFlowOpts
): Element<ExecuteCtx> {
  return new Leaf<ExecuteCtx, { readonly sprintId: SprintId }, void>('summarise-execution', {
    useCase: {
      async execute(input) {
        const tasks = await deps.taskRepo.findBySprintId(input.sprintId);
        if (!tasks.ok) {
          // Don't fail the chain on a read-back error — the work has
          // already been done and the trace will surface the failure.
          deps.logger.info(`sprint ${String(input.sprintId)} executed`, { tasks: opts.tasks.length });
          return Result.ok(undefined);
        }
        const total = tasks.value.length;
        const done = tasks.value.filter((t) => t.status === 'done').length;
        const blocked = tasks.value.filter((t) => t.status === 'blocked').length;
        const ctx: Record<string, unknown> = { sprintId: input.sprintId, total, done };
        if (blocked > 0) ctx['blocked'] = blocked;
        deps.logger.success(
          `sprint ${String(input.sprintId)} executed: ${String(done)}/${String(total)} tasks completed`,
          ctx
        );
        return Result.ok(undefined);
      },
    },
    input: (ctx) => ({ sprintId: ctx.sprintId }),
    output: (ctx) => ctx,
  });
}

/**
 * Sprint-start dirty-tree pre-flight. Surveys every unique repo the sprint
 * will touch; when any repo has uncommitted changes, prompts the user for
 * a strategy (stash / reset / continue / cancel). On `cancelled` it surfaces
 * an `invalid-state` failure so the chain stops cleanly without launching
 * any tasks.
 *
 * Skipped when the sprint has zero tasks — the empty-tasks guard above
 * already failed in that case.
 */
function dirtyTreePreflightLeaf(
  deps: Pick<ChainSharedDeps, 'external' | 'prompt' | 'logger'>,
  opts: CreateExecuteFlowOpts
): Element<ExecuteCtx> {
  const useCase = new DirtyTreePreflightUseCase(deps.external, deps.prompt, deps.logger);
  const repoPaths = uniqueRepoPaths(opts.tasks);
  const stashMessage = `ralphctl ${opts.sprintId}`;
  return new Leaf<ExecuteCtx, undefined, DirtyTreePreflightOutput>('dirty-tree-preflight', {
    useCase: {
      async execute() {
        const r = await useCase.execute({ repoPaths, stashMessage });
        if (!r.ok) return Result.error(r.error);
        if (r.value.outcome === 'cancelled') {
          return Result.error(
            new InvalidStateError({
              entity: 'sprint',
              currentState: 'dirty-tree-cancelled',
              attemptedAction: 'execute',
              message: 'sprint start cancelled — uncommitted changes',
            })
          );
        }
        return Result.ok(r.value);
      },
    },
    input: () => undefined,
    output: (ctx, dirtyTreeOutcome) => ({ ...ctx, dirtyTreeOutcome }),
  });
}

function uniqueRepoPaths(tasks: readonly Task[]): readonly AbsolutePath[] {
  const seen = new Set<string>();
  const out: AbsolutePath[] = [];
  for (const t of tasks) {
    if (seen.has(t.projectPath)) continue;
    seen.add(t.projectPath);
    out.push(t.projectPath);
  }
  return out;
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
  inner: Element<PerTaskCtx>,
  opts: CreateExecuteFlowOpts,
  taskRepo: ChainSharedDeps['taskRepo']
): Element<ExecuteCtx> {
  return new Leaf<ExecuteCtx, ExecuteCtx, ExecuteCtx>(`task-${task.id}`, {
    useCase: {
      async execute(input) {
        // Re-read the task list fresh from the repo at the start of each
        // bridge execution so the second and later per-task children see
        // evaluations recorded by prior siblings. Falls back to the outer
        // ctx snapshot (which `load-tasks` set before `execute-tasks`)
        // when the repo read fails.
        const fresh = await taskRepo.findBySprintId(input.sprintId);
        const liveTasks = fresh.ok ? fresh.value : (input.tasks ?? opts.tasks);
        const innerCtx: PerTaskCtx = {
          sprintId: input.sprintId,
          sprint: opts.sprint,
          task,
          tasks: liveTasks,
          cwd: task.projectPath,
          expectedBranch: input.expectedBranch,
          ...(input.checkScript !== undefined ? { checkScript: input.checkScript } : {}),
          ...(input.noCommit === true ? { noCommit: true } : {}),
        };
        const innerResult = await inner.execute(innerCtx);
        if (!innerResult.ok) {
          // Per-task failure surfaces. The outer Sequential aborts on
          // the first error, but in practice the per-task chain catches
          // its own failures (preflight → mark-blocked, abort → mark-cancelled,
          // evaluator → noop) and resolves successfully so the next task
          // continues.
          return Result.error(innerResult.error.error);
        }
        return Result.ok(input);
      },
    },
    input: (ctx) => ctx,
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
 * Validates that every `blockedBy` reference in the runnable task list
 * points to a task that actually exists in the sprint, and that no task
 * references itself. This gate exists for **actionable diagnostics** —
 * the error names the offending task id and the bad reference so the
 * user knows exactly what to fix. `topologicalReorder` (which runs at
 * factory construction time) can surface unknown-dep as well, but only
 * after filtering settled tasks; a phantom id that survived the settled-
 * id filter would reach the sort silently. The self-reference case
 * (`task A blockedBy [A]`) may also surface confusingly in the sort
 * trace. Running this gate before `assert-tasks-acyclic` ensures the
 * runtime trace always pinpoints the first concrete violation.
 *
 * Checks ALL tasks in ctx.tasks (full sprint list), but only validates
 * the blockedBy entries of tasks that are still runnable (status not
 * 'done' / 'blocked'), mirroring the same filter applied at construction
 * time. A reference to a settled task is valid — the dep is satisfied.
 */
function assertTasksBlockedByResolvableLeaf(): Element<ExecuteCtx> {
  return new Leaf<ExecuteCtx, { readonly tasks: readonly Task[] }, void>('assert-tasks-blocked-by-resolvable', {
    useCase: {
      async execute(input) {
        const allIds = new Set(input.tasks.map((t) => String(t.id)));
        const runnable = input.tasks.filter((t) => t.status !== 'done' && t.status !== 'blocked');
        for (const task of runnable) {
          for (const depId of task.blockedBy) {
            const depStr = String(depId);
            // Self-reference: a task that depends on itself will never be runnable.
            if (depStr === String(task.id)) {
              return Promise.resolve(
                Result.error(
                  new InvalidStateError({
                    entity: 'sprint',
                    currentState: 'self-reference',
                    attemptedAction: 'execute',
                    message: `task ${String(task.id)} lists itself in blockedBy — self-references are not allowed`,
                  })
                )
              );
            }
            // Unknown reference: points to a task id not present in the sprint at all.
            if (!allIds.has(depStr)) {
              return Promise.resolve(
                Result.error(
                  new InvalidStateError({
                    entity: 'sprint',
                    currentState: 'unknown-dep',
                    attemptedAction: 'execute',
                    message: `task ${String(task.id)} has blockedBy: ${depStr}, which is not a task in this sprint`,
                  })
                )
              );
            }
          }
        }
        return Promise.resolve(Result.ok(undefined));
      },
    },
    input: (ctx) => ({ tasks: ctx.tasks ?? [] }),
    output: (ctx) => ctx,
  });
}

/**
 * Re-surface a topological-sort failure (cycle / unknown-dep) as an
 * `InvalidStateError` so the chain stops cleanly with a useful message
 * instead of looping forever or running tasks in a broken order.
 *
 * The actual sort runs at factory time so the linearised children list
 * is available when constructing the Sequential. This leaf turns the
 * captured outcome into a chain-visible failure on the runtime trace.
 */
function assertTasksAcyclicLeaf(sortResult: ReturnType<typeof topologicalReorder<Task>>): Element<ExecuteCtx> {
  return new Leaf<ExecuteCtx, undefined, void>('assert-tasks-acyclic', {
    useCase: {
      async execute() {
        if (sortResult.ok) return Promise.resolve(Result.ok(undefined));
        const err = sortResult.error;
        const message =
          err.code === 'cycle'
            ? `task dependency graph has a cycle: ${err.cycle.join(' → ')}`
            : `task ${err.from} declares blockedBy: ${err.to}, which is not a task in this sprint`;
        return Promise.resolve(
          Result.error(
            new InvalidStateError({
              entity: 'sprint',
              currentState: err.code,
              attemptedAction: 'execute',
              message,
            })
          )
        );
      },
    },
    input: () => undefined,
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
