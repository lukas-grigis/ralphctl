import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { Task } from '@src/domain/entity/task.ts';
import { scheduleIntoWaves } from '@src/domain/entity/task-graph.ts';
import type { RepositoryId } from '@src/domain/value/id/repository-id.ts';
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
import { appendJournalSeparatorLeaf } from '@src/application/flows/_shared/progress/append-journal-separator.ts';
import { createPerTaskSubchain } from '@src/application/flows/implement/leaves/per-task-subchain.ts';
import { type DirtyTreePolicy } from '@src/application/flows/implement/leaves/preflight-task.ts';
import { resolveBranchLeaf } from '@src/application/flows/implement/leaves/resolve-branch.ts';
import { type RepoExecConfig, resolveRepoOrThrow } from '@src/application/flows/implement/leaves/resolve-repo.ts';
import { setupScriptRunnerLeaf } from '@src/application/flows/implement/leaves/setup-script-runner.ts';
import {
  buildPreflightLeaves,
  buildWorkingTreeCleanLeaves,
  setupRepoEntriesForTasks,
  uniqueRepoCwdsForTasks,
} from '@src/application/flows/implement/leaves/sprint-repo-plan.ts';
import { transitionSprintToReviewLeaf } from '@src/application/flows/implement/leaves/transition-sprint-to-review.ts';
import { withRepoLock } from '@src/application/flows/_shared/with-repo-lock.ts';

export type { RepoExecConfig };

/**
 * Per-task subchain's terminal leaf — the leaf that marks "this task is fully settled" for the
 * Tasks-panel bucketing in the TUI. Exported so the launcher can hand it to `SessionDescriptor.
 * terminalSubstepName` instead of duplicating the string literal, and so a rename of the leaf
 * is a single edit that propagates to both the flow definition and the UI's task-completion
 * detection. Keep this in sync with the actual final element name produced by
 * `createPerTaskSubchain` (see `per-task-subchain.ts`).
 */
export const IMPLEMENT_TASK_TERMINAL_LEAF = 'uninstall-skills';

export interface CreateImplementFlowOpts {
  readonly sprintId: SprintId;
  /**
   * Tasks to run, in processing order. The caller passes the resumable set —
   * `status === 'todo'` for fresh tasks and `status === 'in_progress'` for tasks that a
   * prior aborted chain started but didn't finish. The per-task sub-chain handles both
   * uniformly: the `start-attempt` use case settles any leftover `running` attempt as
   * `aborted` before opening a new one, so resume works without operator intervention.
   *
   * Sort by `Task.order` ASC, respecting `dependsOn` if applicable. The chain unrolls
   * per-task sub-chains at construction time so the trace names every task.
   */
  readonly todoTasks: readonly Task[];
  /**
   * Project repositories keyed by id. Every `Task.repositoryId` must resolve through this map;
   * the per-task sub-chain pulls the cwd / verify-script / setup-script from the entry for the
   * task's repo so the implement chain works correctly on multi-repo projects.
   */
  readonly repositories: ReadonlyMap<RepositoryId, RepoExecConfig>;
  /** Absolute path to `<sprintDir>/progress.md`, derived by the launcher and passed in as opts. */
  readonly progressFile: AbsolutePath;
  /**
   * Absolute path to `<sprintDir>` — the sprint's persisted-state folder. Used by
   * `buildTaskWorkspaceLeaf` to root the per-task `implement/<task-id>/` audit tree, and as
   * the lock key for the sprint-wide repo lock (a single implement run at a time across all
   * repos the sprint touches).
   */
  readonly sprintDir: AbsolutePath;
  /**
   * Generator-role provider id — `settings.ai.implement.generator.provider`. Stamped into
   * per-spawn `meta.json` (generic shared sidecar) and `role-meta.json` (implement-specific
   * sidecar) for attribution.
   */
  readonly generatorProviderId: string;
  /** Generator-role model — `settings.ai.implement.generator.model`. */
  readonly generatorModel: string;
  /** Generator-role effort / reasoning level — threaded into the generator AiSession. */
  readonly generatorEffort?: string;
  /**
   * Evaluator-role provider id — `settings.ai.implement.evaluator.provider`. Stamped into
   * per-spawn `meta.json` (generic shared sidecar) and `role-meta.json` (implement-specific
   * sidecar) for attribution.
   */
  readonly evaluatorProviderId: string;
  /** Evaluator-role model — `settings.ai.implement.evaluator.model`. */
  readonly evaluatorModel: string;
  /** Evaluator-role effort / reasoning level — threaded into the evaluator AiSession. */
  readonly evaluatorEffort?: string;
  /**
   * How preflight handles a dirty working tree. Default `'prompt'` — interactive recovery
   * (Keep / Stash / Reset / Cancel). Non-interactive callers (CI, headless harness) should
   * explicitly pass `'cancel'` or `'continue'`.
   */
  readonly dirtyTreePolicy?: DirtyTreePolicy;
  /**
   * `<dataRoot>/memory` — durable, project-scoped learnings root. Threaded into each
   * per-task sub-chain's `append-learnings` leaf so `<learning>` signals persist to
   * `<memoryRoot>/<projectId>/learnings.ndjson`.
   */
  readonly memoryRoot: AbsolutePath;
  /** Owning project's id — selects the per-project learnings ledger subdirectory. */
  readonly projectId: string;
}

/**
 * Build the implement chain. One invocation runs up to `task.maxAttempts` attempts per task —
 * the per-task sub-chain wraps the attempt segment in an inner `loop` that re-enters until the
 * task settles `done`/`blocked` or the cap fires — and transitions the sprint into `review` once
 * every todo task has settled.
 *
 * Shape:
 *
 *   sequential('implement', [
 *     with-repo-lock(
 *       sequential('implement-locked', [
 *         load-and-assert-sprint(['planned', 'active']),
 *         activate-sprint,
 *         load-sprint-execution,
 *         load-tasks,
 *         resolve-branch,                  // assigns ralphctl/<id> on first run, persists, checks out
 *         working-tree-clean-checks,       // one per repo: hard-abort if dirty (no recovery menu)
 *         progress-journal-activate,       // separator line in progress.md
 *         setup-script-runner,             // runs only after branch + clean check pass
 *         preflight-tasks,                 // interactive dirty-tree menu — one per repo, one-shot
 *         implement-tasks,                 // sequential task-<id> sub-chains
 *         save-tasks,
 *         transition-sprint-to-review(when every task settled AND ≥1 done)
 *       ])
 *     ),
 *   ])
 *
 * The prologue leaves (`load-and-assert-sprint` … `preflight-tasks`) and epilogue leaves
 * (`save-tasks`, the review-transition guard) are sourced from {@link buildImplementPrologue} /
 * {@link buildImplementEpilogue} — the SAME leaf instances the parallel launcher consumes via
 * {@link planImplementWaves}, spliced INLINE here (not nested) so the serial `implement-locked`
 * shape is byte-for-byte unchanged. The `implement-prologue` / `implement-epilogue` wrapper names
 * exist only in the parallel plan, never in this serial tree.
 *
 * See `per-task-subchain.ts` for the per-task body and `gen-eval-loop.ts` for the inner
 * generator-evaluator loop.
 *
 * Skills are linked into the user's repo at `<repo>/<parentDir>/skills/ralphctl-<name>/` — the
 * provider-native conventions (`.claude/skills`, `.github/skills`, `.agents/skills`) only
 * auto-discover from cwd, so the AI session uses the repo as its `cwd` and the per-task
 * workspace as `--add-dir`. The `ralphctl-` prefix combined with one wildcard line in
 * `.git/info/exclude` keeps `git status` clean of harness-managed context.
 *
 * Preflight rationale: the dirty-tree check is a precondition for the whole invocation, not for
 * each task. Between tasks the tree is clean (commit-task commits each task's work), so a
 * per-task check just re-asserts what's already known. Running preflight ONCE at the outer level
 * also lets `install-skills` materialise its files afterwards without tripping the check.
 *
 * Pre-setup gate rationale: branch resolution + a hard `working-tree-clean-check` (no recovery
 * menu) run BEFORE `setup-script-runner`. Setup commands typically assume a "ready" tree —
 * `pnpm install --frozen-lockfile`, schema migrations, etc — and can fail in confusing ways
 * against a dirty repo. Front-loading the branch + clean check means the user kicks off the
 * implement chain, sees branch + setup turn green, and can step away from the computer with
 * confidence the run won't fail at a stupid place. The interactive preflight-task leaf (Keep /
 * Stash / Reset / Cancel) still runs downstream of setup so the user has a recovery seam for
 * any drift that arose between sprint creation and implement launch.
 *
 * Branch preflight rationale: the dirty-tree check is one-shot but the branch can drift mid-run
 * (an AI generator turn with shell access could `git checkout` away). `resolve-branch` pins the
 * tree once at the outer level; `branch-preflight` re-asserts at the start of every per-task
 * sub-chain so a wrong-branch commit never lands.
 *
 * ## Continue-on-blocked
 *
 * Tasks that settle to `blocked` (self-block reason) do NOT halt the chain — the next task's
 * sub-chain runs unconditionally. Infrastructure failures (preflight rejection, repository
 * write errors) DO halt: those are not domain decisions.
 *
 * ## Review transition is conditional
 *
 * The sprint only transitions `active → review` when at least one task settled `done`. An
 * all-blocked run keeps the sprint in `active`, so re-running implement after the user fixes
 * the blocker just retries the blocked tasks — no manual sprint state-back-out. Mixed runs
 * (some done + some blocked) still transition: the completed work is real and reviewable.
 *
 * ## Per-attempt vs per-task budgets
 *
 * - `config.harness.maxTurns` bounds the gen-eval inner loop (turns per attempt).
 * - `task.maxAttempts` bounds attempts per task. A single launch now runs up to `maxAttempts`
 *   attempts: the per-task sub-chain's inner `loop('task-attempts-<id>', …)` re-enters the
 *   start-attempt → … → settle segment until the task settles `done`/`blocked` or the cap
 *   fires (the domain transitions a budget-exhausted task to `blocked`, never silently drops
 *   it). When `maxAttempts === 1` the loop runs exactly once — byte-for-byte with the prior
 *   single-attempt-per-launch behaviour. A task left `in_progress` after the loop (e.g. the
 *   launch ended before the cap because the operator aborted) is still picked up by re-running
 *   the chain.
 */
/**
 * Build the prologue segment — everything from `load-and-assert-sprint` through `preflight-tasks`,
 * the once-per-run setup that runs BEFORE any task executes:
 *
 *   load-and-assert-sprint → activate → load-execution → load-tasks → resolve-branch →
 *   working-tree-clean-checks → progress-journal-activate → setup-script-runner → preflight-tasks
 *
 * Returned as `sequential('implement-prologue', [...])` so the parallel launcher can run it
 * once on a dedicated runner under the held lock before fanning the task waves out. The serial
 * `createImplementFlow` does NOT nest this wrapper — it splices the same leaf instances inline
 * (via `.children`) so the serial observable chain shape stays byte-for-byte unchanged.
 *
 * @public
 */
export const buildImplementPrologue = (deps: ImplementDeps, opts: CreateImplementFlowOpts): Element<ImplementCtx> => {
  // Per-repo derived shapes — unique cwds drive `resolve-branch`, the clean-check fan-out, and
  // the per-repo preflight; the setup-script entries are repo + setupScript pairs scoped to the
  // tasks the sprint actually runs. See `sprint-repo-plan.ts` for the rationale.
  const uniqueRepoCwds = uniqueRepoCwdsForTasks(opts.repositories, opts.todoTasks);
  const setupRepoEntries = setupRepoEntriesForTasks(opts.repositories, opts.todoTasks);

  // Default to 'prompt' so the interactive recovery menu (Keep / Stash / Reset / Cancel) fires;
  // the business-layer default stays 'cancel' for non-interactive callers in isolation.
  const dirtyTreePolicy: DirtyTreePolicy = opts.dirtyTreePolicy ?? 'prompt';
  const preflightLeaves = buildPreflightLeaves(
    {
      gitRunner: deps.gitRunner,
      interactive: deps.interactive,
      clock: deps.clock,
      logger: deps.logger,
    },
    uniqueRepoCwds,
    dirtyTreePolicy
  );
  const workingTreeCleanLeaves = buildWorkingTreeCleanLeaves(
    { gitRunner: deps.gitRunner, logger: deps.logger },
    uniqueRepoCwds
  );

  return sequential<ImplementCtx>('implement-prologue', [
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
    // Record sprint activation in the journal — fires after the implement chain activated the
    // sprint (or noop'd because it was already active). The separator gives the operator + AI
    // a chronological marker between "before this run" and "first task of this run."
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
  ]);
};

/**
 * Build the epilogue segment — the once-per-run teardown that runs AFTER every task has settled:
 *
 *   save-tasks → transition-sprint-to-review(when every task settled AND ≥1 done)
 *
 * Returned as `sequential('implement-epilogue', [...])` so the parallel launcher can run it
 * once on a dedicated runner under the held lock — including on the abort/fatal path, where the
 * `save-tasks` leaf must still persist the partially-merged ctx so folded commits are durably
 * recorded. The serial `createImplementFlow` does NOT nest this wrapper — it splices the same leaf
 * instances inline (via `.children`) so the serial observable chain shape stays byte-for-byte
 * unchanged.
 *
 * @public
 */
/**
 * Predicate for the active→review transition at the end of an implement run. The sprint flips
 * to review only when the run has genuinely finished: every task has settled (`done`/`blocked`,
 * so no `todo`/`in_progress` remains) AND at least one settled `done`. See the inline notes at
 * the guard site for the two failure modes this guards (premature mid-run flip; all-blocked).
 * Extracted as a pure function so the transition rule is unit-testable independent of the chain.
 *
 * @public
 */
export const shouldTransitionToReview = (tasks: ImplementCtx['tasks']): boolean => {
  const list = tasks ?? [];
  const someDone = list.some((t) => t.status === 'done');
  const noneRunnable = !list.some((t) => t.status === 'todo' || t.status === 'in_progress');
  return someDone && noneRunnable;
};

export const buildImplementEpilogue = (deps: ImplementDeps, opts: CreateImplementFlowOpts): Element<ImplementCtx> =>
  sequential<ImplementCtx>('implement-epilogue', [
    saveTasksLeaf<ImplementCtx>({ taskRepo: deps.taskRepo }),
    // Transition to review only when the run has genuinely finished — every task settled
    // (`done` or `blocked`) AND at least one task settled `done`. Two failure modes this guards:
    //   1. Premature flip: the prior `some(done)` predicate flipped to review the instant ONE
    //      task finished, even while other tasks were still `todo` / `in_progress` — silently
    //      shipping a partial sprint mid-run. Requiring "no runnable work left" keeps the sprint
    //      `active` until every task has actually settled, so the operator never sees a sprint in
    //      review with work still pending.
    //   2. All-blocked: if nothing settled `done` (e.g. a foundational task blocked and cascaded
    //      to its dependents), there's nothing to review — staying `active` lets the operator fix
    //      the blocker and re-run implement without first backing the sprint out of review.
    // A mixed end state (some done, some blocked) still transitions: the run is complete and the
    // blocked tasks are surfaced in review for a deliberate close decision — no longer a silent
    // mid-run partial ship.
    guard<ImplementCtx>(
      'transition-sprint-to-review-when-settled',
      (ctx) => shouldTransitionToReview(ctx.tasks),
      sequential<ImplementCtx>('transition-to-review-and-journal', [
        transitionSprintToReviewLeaf({ sprintRepo: deps.sprintRepo, clock: deps.clock, logger: deps.logger }),
        appendJournalSeparatorLeaf<ImplementCtx>(
          { appendFile: deps.appendFile, clock: deps.clock, logger: deps.logger },
          { progressFile: opts.progressFile, status: 'review', name: 'progress-journal-review' }
        ),
      ])
    ),
  ]);

/**
 * The decomposed implement run — prologue / per-task waves / epilogue as separate elements plus
 * the sprint-wide lock key. Produced by {@link planImplementWaves}; consumed by the parallel
 * launcher to run the prologue, then `runWaves` over the per-task waves, then the epilogue,
 * all under ONE held `fileLocker.withLock(lockKey)`.
 *
 * The serial `createImplementFlow` keeps its own internal `withRepoLock`-wrapped chain — the
 * serial `===1` path keeps the lock inside the flow. This plan exists purely so the `>1`
 * parallel path can be wired without re-deriving the segments.
 *
 * @public
 */
export interface ImplementWavePlan {
  /**
   * `sequential('implement-prologue', [...])` — the once-per-run setup (load → setup → preflight).
   * Run once on its own runner before the waves.
   */
  readonly prologue: Element<ImplementCtx>;
  /**
   * Dependency layers from `scheduleIntoWaves(opts.todoTasks)` — each inner array is a set of
   * tasks with no intra-wave dependency, safe to run concurrently. The parallel path forks one
   * branch per task in a wave and hands the wave to `runWaves`. Waves are strictly ordered: every dependency of a
   * task in wave `k` was scheduled in some wave `< k`.
   */
  readonly waves: ReadonlyArray<readonly Task[]>;
  /**
   * `sequential('implement-epilogue', [...])` — the once-per-run teardown (save → transition).
   * Run once on its own runner after the waves (including on the abort/fatal path, so folded
   * commits are durably persisted).
   */
  readonly epilogue: Element<ImplementCtx>;
  /**
   * Sprint-wide lock key — the sprint dir. The parallel launcher hoists ONE held lock on this
   * key across prologue + waves + epilogue — the lock is hoisted for the `>1` path. Mirrors
   * the `worktreePath` the serial path's internal `withRepoLock` uses.
   */
  readonly lockKey: AbsolutePath;
}

/**
 * Decompose an implement run into its reusable segments for the parallel launcher.
 *
 * Returns the extracted {@link buildImplementPrologue} / {@link buildImplementEpilogue} segments,
 * the dependency-scheduled task waves (`scheduleIntoWaves(opts.todoTasks)`), and the sprint-wide
 * lock key. Lands NO parallel behaviour itself — it only computes the plan; the parallel launcher
 * is the consumer that runs the prologue, fans the waves out via `runWaves`, and runs the epilogue under one held
 * lock.
 *
 * On an unschedulable task set (cycle / self-edge / dangling dependency) the wave schedule fails.
 * `launchImplement` already validates + schedules the full task set upfront (see
 * `resolveImplementQueue`), so by the time the launcher builds a plan from the resumable queue the
 * graph is known sound; the `Result.ok` branch is therefore the expected path. A `TaskGraphIssue`
 * is propagated as an empty wave list so a mis-sequenced caller fails closed (no tasks scheduled)
 * rather than throwing at construction time.
 *
 * @public
 */
export const planImplementWaves = (deps: ImplementDeps, opts: CreateImplementFlowOpts): ImplementWavePlan => {
  const schedule = scheduleIntoWaves(opts.todoTasks);
  return {
    prologue: buildImplementPrologue(deps, opts),
    waves: schedule.ok ? schedule.value : [],
    epilogue: buildImplementEpilogue(deps, opts),
    lockKey: opts.sprintDir,
  };
};

export const createImplementFlow = (deps: ImplementDeps, opts: CreateImplementFlowOpts): Element<ImplementCtx> => {
  // Promise-shaped accessor read by `finalize-gen-eval` and the gen-eval loop's
  // `shouldContinue` predicate. Re-resolved per call so a mid-run config edit (lower maxTurns,
  // toggle escalation) takes effect on the next iteration rather than requiring a restart.
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

  // Serial path: the lock stays inside the flow — the `implement-locked` body is the SAME flat list of leaf instances it
  // has always been — the prologue/epilogue segment builders supply those instances via `.children`
  // (spliced inline, not nested), so the serial observable chain shape stays byte-for-byte
  // unchanged. The `implement-prologue` / `implement-epilogue` wrapper names exist ONLY in the
  // segments the parallel launcher consumes via `planImplementWaves`; they never appear in this serial tree.
  const prologueLeaves = buildImplementPrologue(deps, opts).children ?? [];
  const epilogueLeaves = buildImplementEpilogue(deps, opts).children ?? [];

  const inner = sequential<ImplementCtx>('implement-locked', [
    ...prologueLeaves,
    sequential<ImplementCtx>('implement-tasks', perTaskChains),
    ...epilogueLeaves,
  ]);

  // Lock key: the sprint dir. One implement run at a time per sprint — across all repos the
  // sprint touches — rather than per-repo, since the chain owns sprint-scoped state
  // (`tasks.json`, `progress.md`, `execution.json`) that would race under concurrent runs
  // even when the underlying repos differ.
  return sequential<ImplementCtx>('implement', [
    withRepoLock(
      {
        fileLocker: deps.fileLocker,
        locksRoot: deps.locksRoot,
        worktreePath: opts.sprintDir,
        eventBus: deps.eventBus,
      },
      inner
    ),
  ]);
};
