import { Result } from '@src/domain/result.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { Task } from '@src/domain/entity/task.ts';
import { scheduleIntoWaves, type TaskGraphIssue } from '@src/domain/entity/task-graph.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import type { Slug } from '@src/domain/value/slug.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { Element } from '@src/application/chain/element.ts';
import { guard } from '@src/application/chain/build/guard.ts';
import { sequential } from '@src/application/chain/build/sequential.ts';
import { loadSprintExecutionLeaf } from '@src/application/flows/_shared/sprint/load-execution.ts';
import { loadTasksLeaf } from '@src/application/flows/_shared/task/load.ts';
import { saveTasksLeaf } from '@src/application/flows/_shared/task/save.ts';
import { loadAndAssertSprintSubChain } from '@src/application/flows/_shared/sprint/load-and-assert-sprint.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import type { ImplementDeps } from '@src/application/flows/implement/deps.ts';
import { activateSprintLeaf } from '@src/application/flows/implement/leaves/activate-sprint.ts';
import { adoptPersistedBlocksLeaf } from '@src/application/flows/implement/leaves/adopt-persisted-blocks.ts';
import { appendJournalSeparatorLeaf } from '@src/application/flows/_shared/progress/append-journal-separator.ts';
import {
  createPerTaskSubchain,
  type PerTaskSubchainOpts,
} from '@src/application/flows/implement/leaves/per-task-subchain.ts';
import { buildAttemptReadConfig } from '@src/application/flows/implement/leaves/attempt-body.ts';
import { type DirtyTreePolicy } from '@src/application/flows/implement/leaves/preflight-task.ts';
import { resolveBranchLeaf } from '@src/application/flows/implement/leaves/resolve-branch.ts';
import { type RepoExecConfig, resolveRepoOrThrow } from '@src/application/flows/implement/leaves/resolve-repo.ts';
import { setupScriptRunnerLeaf } from '@src/application/flows/implement/leaves/setup-script-runner.ts';
import { createSetupTreeGuard } from '@src/application/flows/implement/leaves/setup-tree-guard.ts';
import {
  buildPreflightLeaves,
  interruptedAttemptsByCwd,
  setupRepoEntriesForTasks,
  uniqueRepoCwdsForTasks,
} from '@src/application/flows/implement/leaves/sprint-repo-plan.ts';
import { transitionSprintToReviewLeaf } from '@src/application/flows/implement/leaves/transition-sprint-to-review.ts';
import { withRepoLock } from '@src/application/flows/_shared/with-repo-lock.ts';
import { loadLearningsLeaf } from '@src/application/flows/_shared/memory/load-learnings.ts';
import { resolveLearningsLedgerPath } from '@src/application/flows/_shared/memory/ledger-path.ts';
import type { AgentDefinition } from '@src/integration/ai/agents/_engine/agent-definition.ts';

export type { RepoExecConfig };

export interface CreateImplementFlowOpts {
  readonly sprintId: SprintId;
  /**
   * The resumable tasks (`todo` + `in_progress`) in processing order. `start-attempt` settles a
   * leftover `running` attempt as `aborted` before opening a new one, so resume needs no operator.
   */
  readonly todoTasks: readonly Task[];
  /**
   * Ids outside `todoTasks` that already satisfy a dependency (the sprint's `done` and `blocked`
   * tasks — `dependency-gate` parks a dependent behind a blocked one at run time). Without it a
   * resumed run's dependency on a settled task looks dangling and `scheduleIntoWaves` fails closed.
   */
  readonly satisfiedDependencyIds?: ReadonlySet<TaskId>;
  /** Project repositories keyed by id; every `Task.repositoryId` must resolve through it. */
  readonly repositories: ReadonlyMap<RepositoryId, RepoExecConfig>;
  /** Absolute path to `<sprintDir>/progress.md`, derived by the launcher and passed in as opts. */
  readonly progressFile: AbsolutePath;
  /** `<sprintDir>` — roots the per-task `implement/<task-id>/` tree and keys the sprint-wide lock. */
  readonly sprintDir: AbsolutePath;
  /** `settings.ai.implement.generator.provider` — stamped into `meta.json` / `role-meta.json`. */
  readonly generatorProviderId: string;
  /** Generator-role model — `settings.ai.implement.generator.model`. */
  readonly generatorModel: string;
  /** Generator-role effort / reasoning level — threaded into the generator AiSession. */
  readonly generatorEffort?: string;
  /** `settings.ai.implement.evaluator.provider` — stamped into `meta.json` / `role-meta.json`. */
  readonly evaluatorProviderId: string;
  /** Evaluator-role model — `settings.ai.implement.evaluator.model`. */
  readonly evaluatorModel: string;
  /** Evaluator-role effort / reasoning level — threaded into the evaluator AiSession. */
  readonly evaluatorEffort?: string;
  /** Generator-role's bound agent definition; `undefined` when unbound or unresolved. */
  readonly generatorAgentDefinition?: AgentDefinition;
  /**
   * Pre-composed "## Agent Definition" prompt section for the generator; rides only the full prompt
   * (a resumed continuation already carries it).
   */
  readonly generatorAgentDefinitionSection?: string;
  /** Evaluator-role's bound agent definition — see {@link generatorAgentDefinition}. */
  readonly evaluatorAgentDefinition?: AgentDefinition;
  /** Evaluator-role's "## Agent Definition" prompt section — see {@link generatorAgentDefinitionSection}. */
  readonly evaluatorAgentDefinitionSection?: string;
  /**
   * How preflight handles a dirty working tree. Default `'prompt'` — interactive recovery
   * (Keep / Stash / Reset / Cancel). Non-interactive callers (CI, headless harness) should
   * explicitly pass `'cancel'` or `'continue'`.
   */
  readonly dirtyTreePolicy?: DirtyTreePolicy;
  /** `<dataRoot>/memory` — root of the per-project learnings ledger. */
  readonly memoryRoot: AbsolutePath;
  /** Owning project's id — selects the per-project learnings ledger subdirectory. */
  readonly projectId: string;
  /** Owning project's slug — builds the human-readable `<id>--<slug>/` ledger subdirectory. */
  readonly projectSlug: Slug;
}

/**
 * The run's dirty-tree policy. Defaults to `'prompt'` so the interactive recovery menu (Keep /
 * Stash / Reset / Cancel) fires; the business-layer default stays `'cancel'` for non-interactive
 * callers in isolation. One place, because the prologue's checks and every parallel task
 * worktree's setup check must apply the same policy.
 */
export const effectiveDirtyTreePolicy = (opts: Pick<CreateImplementFlowOpts, 'dirtyTreePolicy'>): DirtyTreePolicy =>
  opts.dirtyTreePolicy ?? 'prompt';

/**
 * The once-per-run setup before any task runs. The parallel launcher runs this segment on its own
 * runner; the serial flow executes the same leaves spliced flat (see `groupedForDisplay`).
 */
export const buildImplementPrologue = (deps: ImplementDeps, opts: CreateImplementFlowOpts): Element<ImplementCtx> => {
  const uniqueRepoCwds = uniqueRepoCwdsForTasks(opts.repositories, opts.todoTasks);
  const setupRepoEntries = setupRepoEntriesForTasks(opts.repositories, opts.todoTasks);

  const dirtyTreePolicy = effectiveDirtyTreePolicy(opts);
  const treeDeps = {
    gitRunner: deps.gitRunner,
    interactive: deps.interactive,
    clock: deps.clock,
    logger: deps.logger,
  };
  const preflightLeaves = buildPreflightLeaves(
    treeDeps,
    uniqueRepoCwds,
    dirtyTreePolicy,
    interruptedAttemptsByCwd(opts.repositories, opts.todoTasks)
  );

  return sequential<ImplementCtx>(
    'implement-prologue',
    [
      loadAndAssertSprintSubChain<ImplementCtx>({ sprintRepo: deps.sprintRepo }, ['planned', 'active']),
      activateSprintLeaf({ sprintRepo: deps.sprintRepo, clock: deps.clock, logger: deps.logger }),
      loadSprintExecutionLeaf<ImplementCtx>({ sprintExecutionRepo: deps.sprintExecutionRepo }),
      loadTasksLeaf<ImplementCtx>({ taskRepo: deps.taskRepo }),
      // Prior sprints' not-yet-promoted learnings, read once for every generator; a missing ledger is empty.
      loadLearningsLeaf<ImplementCtx>(
        { logger: deps.logger },
        {
          // Tolerates the legacy bare `<id>/` dir, so a user who declined the migration keeps their learnings.
          path: async () => {
            const resolved = await resolveLearningsLedgerPath(opts.memoryRoot, opts.projectId);
            // projectId is validated upstream, so a failure here is a programmer error.
            if (!resolved.ok) throw resolved.error;
            return resolved.value;
          },
          output: (ctx, candidates) => ({ ...ctx, priorLearnings: candidates }),
        }
      ),
      resolveBranchLeaf(
        {
          gitRunner: deps.gitRunner,
          sprintExecutionRepo: deps.sprintExecutionRepo,
          interactive: deps.interactive,
          logger: deps.logger,
        },
        { cwds: uniqueRepoCwds }
      ),
      // Before setup, so the script runs against a tree the operator already settled.
      sequential<ImplementCtx>('preflight-tasks', preflightLeaves),
      appendJournalSeparatorLeaf<ImplementCtx>(
        { appendFile: deps.appendFile, writeFile: deps.writeFile, clock: deps.clock, logger: deps.logger },
        { progressFile: opts.progressFile, status: 'activated', name: 'progress-journal-activate' }
      ),
      // Re-offers the dirty-tree choice only for what a setup script itself changed.
      setupScriptRunnerLeaf(
        {
          shellScriptRunner: deps.shellScriptRunner,
          clock: deps.clock,
          eventBus: deps.eventBus,
          sprintExecutionRepo: deps.sprintExecutionRepo,
          logger: deps.logger,
          treeGuard: createSetupTreeGuard(treeDeps, { policy: dirtyTreePolicy, sprintId: String(opts.sprintId) }),
        },
        { repos: setupRepoEntries, sprintDir: opts.sprintDir }
      ),
    ],
    { label: 'Prepare' }
  );
};

/**
 * The sprint moves to review only once no task is runnable AND at least one is `done`: never
 * mid-run, and never for an all-blocked run (fix the blocker and re-run without backing out).
 */
export const shouldTransitionToReview = (tasks: ImplementCtx['tasks']): boolean => {
  const list = tasks ?? [];
  const someDone = list.some((t) => t.status === 'done');
  const noneRunnable = !list.some((t) => t.status === 'todo' || t.status === 'in_progress');
  return someDone && noneRunnable;
};

/**
 * The once-per-run teardown after every task settled. The parallel launcher runs it even on the
 * abort/fatal path so folded commits are recorded.
 */
export const buildImplementEpilogue = (deps: ImplementDeps, opts: CreateImplementFlowOpts): Element<ImplementCtx> =>
  sequential<ImplementCtx>(
    'implement-epilogue',
    [
      saveTasksLeaf<ImplementCtx>({ taskRepo: deps.taskRepo }),
      guard<ImplementCtx>(
        'transition-sprint-to-review-when-settled',
        (ctx) => shouldTransitionToReview(ctx.tasks),
        sequential<ImplementCtx>('transition-to-review-and-journal', [
          transitionSprintToReviewLeaf({ sprintRepo: deps.sprintRepo, clock: deps.clock, logger: deps.logger }),
          appendJournalSeparatorLeaf<ImplementCtx>(
            { appendFile: deps.appendFile, writeFile: deps.writeFile, clock: deps.clock, logger: deps.logger },
            { progressFile: opts.progressFile, status: 'review', name: 'progress-journal-review' }
          ),
        ])
      ),
    ],
    { label: 'Finish' }
  );

/**
 * The parallel epilogue: {@link buildImplementEpilogue} prefixed with `adopt-persisted-blocks`.
 * `mergeImplementWave` skips a branch that failed after persisting its task (a block, an opened
 * attempt), so without the adopt step `save-tasks` would overwrite that write with the pre-wave
 * copy. The serial path never needs it: its tasks share one `ctx.tasks`. Same segment name on purpose.
 */
export const buildParallelImplementEpilogue = (
  deps: ImplementDeps,
  opts: CreateImplementFlowOpts
): Element<ImplementCtx> =>
  sequential<ImplementCtx>(
    'implement-epilogue',
    [
      adoptPersistedBlocksLeaf({ taskRepo: deps.taskRepo, logger: deps.logger }),
      ...(buildImplementEpilogue(deps, opts).children ?? []),
    ],
    { label: 'Finish' }
  );

/** The parallel run's segments, all run under ONE held lock on `lockKey`. */
export interface ImplementWavePlan {
  readonly prologue: Element<ImplementCtx>;
  /** Dependency layers: no intra-wave dependency, and every dependency sits in an earlier wave. */
  readonly waves: ReadonlyArray<readonly Task[]>;
  /** {@link buildParallelImplementEpilogue} — runs after the waves, on the abort/fatal path too. */
  readonly epilogue: Element<ImplementCtx>;
  /** The sprint dir — the same key the serial path's `withRepoLock` uses. */
  readonly lockKey: AbsolutePath;
}

/**
 * Plan the parallel run. An unschedulable task set (cycle, self-edge, a dependency in neither
 * `todoTasks` nor `satisfiedDependencyIds`) is an error the launcher must surface — never an empty
 * plan that would report `completed` having done no work.
 */
export const planImplementWaves = (
  deps: ImplementDeps,
  opts: CreateImplementFlowOpts
): Result<ImplementWavePlan, TaskGraphIssue> => {
  const schedule = scheduleIntoWaves(opts.todoTasks, opts.satisfiedDependencyIds ?? new Set());
  if (!schedule.ok) return Result.error(schedule.error);
  return Result.ok({
    prologue: buildImplementPrologue(deps, opts),
    waves: schedule.value,
    epilogue: buildParallelImplementEpilogue(deps, opts),
    lockKey: opts.sprintDir,
  });
};

// Shared by the serial and parallel builders so the per-task options can't drift.
export const perTaskSubchainOpts = (opts: CreateImplementFlowOpts): PerTaskSubchainOpts => ({
  sprintDir: opts.sprintDir,
  progressFile: opts.progressFile,
  generator: {
    providerId: opts.generatorProviderId,
    model: opts.generatorModel,
    ...(opts.generatorEffort !== undefined ? { effort: opts.generatorEffort } : {}),
    ...(opts.generatorAgentDefinitionSection !== undefined
      ? { agentDefinitionSection: opts.generatorAgentDefinitionSection }
      : {}),
  },
  evaluator: {
    providerId: opts.evaluatorProviderId,
    model: opts.evaluatorModel,
    ...(opts.evaluatorEffort !== undefined ? { effort: opts.evaluatorEffort } : {}),
    ...(opts.evaluatorAgentDefinitionSection !== undefined
      ? { agentDefinitionSection: opts.evaluatorAgentDefinitionSection }
      : {}),
  },
  memoryRoot: opts.memoryRoot,
  projectId: opts.projectId,
  projectSlug: opts.projectSlug,
  ...(opts.generatorAgentDefinition !== undefined ? { generatorAgentDefinition: opts.generatorAgentDefinition } : {}),
  ...(opts.evaluatorAgentDefinition !== undefined ? { evaluatorAgentDefinition: opts.evaluatorAgentDefinition } : {}),
});

/**
 * Present `flat` (which executes its own children) under `groups` — the same leaf instances, in the
 * same order, nested one level deeper. Display-only: a nested `sequential` would rename the skip
 * entries a failure synthesises (`implement-epilogue` instead of each epilogue child).
 */
const groupedForDisplay = (
  flat: Element<ImplementCtx>,
  groups: ReadonlyArray<Element<ImplementCtx>>
): Element<ImplementCtx> => ({ ...flat, children: groups });

/**
 * The serial implement chain: `implement → with-repo-lock → implement-locked`, whose children are
 * the prologue, one `task-<id>` subchain per todo task (see `per-task-subchain.ts`), and the
 * epilogue. A blocked task never halts the chain; infrastructure failures do.
 *
 * Tree gates: the dirty-tree menu runs once per run, before setup, so branch and tree are the only
 * questions and are asked before the long setup script. `setup-script-runner` re-asks only about
 * dirt the script itself created (WORKFLOWS.md, "setupScript vs verifyScript"). Between tasks the
 * tree stays clean (commit, or the blocked-diff quarantine), so no per-task tree check is needed,
 * but `branch-preflight` re-asserts the branch per task because a generator turn can `git checkout`.
 */
export const createImplementFlow = (deps: ImplementDeps, opts: CreateImplementFlowOpts): Element<ImplementCtx> => {
  // The harness slice frozen at launch: a mid-run settings edit takes effect on the next launch.
  const readConfig = buildAttemptReadConfig(deps.config.harness);

  const subchainOpts = perTaskSubchainOpts(opts);
  const perTaskChains = opts.todoTasks.map((task) =>
    createPerTaskSubchain(deps, subchainOpts, task, resolveRepoOrThrow(opts.repositories, task), readConfig)
  );

  // Executed flat so a failure's skip entries name each leaf; grouped only for display.
  const prologue = buildImplementPrologue(deps, opts);
  const tasks = sequential<ImplementCtx>('implement-tasks', perTaskChains, { label: 'Run tasks' });
  const epilogue = buildImplementEpilogue(deps, opts);
  const inner = groupedForDisplay(
    sequential<ImplementCtx>('implement-locked', [...(prologue.children ?? []), tasks, ...(epilogue.children ?? [])]),
    [prologue, tasks, epilogue]
  );

  // Keyed on the sprint dir, not per repo: the chain owns sprint-scoped files that would race.
  return sequential<ImplementCtx>('implement', [
    withRepoLock(
      {
        fileLocker: deps.fileLocker,
        locksRoot: deps.locksRoot,
        worktreePath: opts.sprintDir,
        eventBus: deps.eventBus,
        purpose: 'implement',
      },
      inner
    ),
  ]);
};
