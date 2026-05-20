import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { HarnessSignal } from '@src/domain/signal.ts';
import type { Element } from '@src/application/chain/element.ts';
import { guard } from '@src/application/chain/build/guard.ts';
import { loop } from '@src/application/chain/build/loop.ts';
import { sequential } from '@src/application/chain/build/sequential.ts';
import { broadcastSink } from '@src/integration/observability/sinks/broadcast-sink.ts';
import { createProgressFileSink } from '@src/integration/observability/sinks/progress-file-sink.ts';
import { loadSprintExecutionLeaf } from '@src/application/flows/_shared/sprint/load-execution.ts';
import { loadTasksLeaf } from '@src/application/flows/_shared/task/load.ts';
import { saveTasksLeaf } from '@src/application/flows/_shared/task/save.ts';
import { loadAndAssertSprintSubChain } from '@src/application/flows/_shared/sprint/load-and-assert-sprint.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import type { ImplementDeps } from '@src/application/flows/implement/deps.ts';
import { activateSprintLeaf } from '@src/application/flows/implement/leaves/activate-sprint.ts';
import { flushProgressSinkLeaf } from '@src/application/flows/implement/leaves/flush-progress-sink.ts';
import { branchPreflightLeaf } from '@src/application/flows/implement/leaves/branch-preflight.ts';
import { commitTaskLeaf } from '@src/application/flows/implement/leaves/commit-task.ts';
import { ensureProgressFileLeaf } from '@src/application/flows/implement/leaves/ensure-progress-file.ts';
import { evaluatorLeaf } from '@src/application/flows/implement/leaves/evaluator.ts';
import { finalizeGenEvalLeaf } from '@src/application/flows/implement/leaves/finalize-gen-eval.ts';
import { generatorLeaf } from '@src/application/flows/implement/leaves/generator.ts';
import { postTaskCheckLeaf } from '@src/application/flows/implement/leaves/post-task-check.ts';
import { preflightTaskLeaf, type DirtyTreePolicy } from '@src/application/flows/implement/leaves/preflight-task.ts';
import { resolveBranchLeaf } from '@src/application/flows/implement/leaves/resolve-branch.ts';
import { settleAttemptLeaf } from '@src/application/flows/implement/leaves/settle-attempt.ts';
import { setupScriptRunnerLeaf } from '@src/application/flows/implement/leaves/setup-script-runner.ts';
import { startAttemptLeaf } from '@src/application/flows/implement/leaves/start-attempt.ts';
import { buildTaskWorkspaceLeaf } from '@src/application/flows/implement/leaves/build-task-workspace.ts';
import { transitionSprintToReviewLeaf } from '@src/application/flows/implement/leaves/transition-sprint-to-review.ts';
import { withRepoLock } from '@src/application/flows/implement/leaves/with-repo-lock.ts';
import { installSkillsLeaf } from '@src/application/flows/_shared/skills/install-skills.ts';
import { uninstallSkillsLeaf } from '@src/application/flows/_shared/skills/uninstall-skills.ts';

/**
 * Per-task subchain's terminal leaf — the leaf that marks "this task is fully settled" for the
 * Tasks-panel bucketing in the TUI. Exported so the launcher can hand it to `SessionDescriptor.
 * terminalSubstepName` instead of duplicating the string literal, and so a rename of the leaf
 * is a single edit that propagates to both the flow definition and the UI's task-completion
 * detection. Keep this in sync with the actual final element name returned from
 * `perTaskSubChain` below.
 */
export const IMPLEMENT_TASK_TERMINAL_LEAF = 'uninstall-skills';

/**
 * Per-repository execution config — path + the scripts the chain runs against that repo. The
 * launcher builds this map from `Project.repositories` (one entry per registered repo).
 */
export interface RepoExecConfig {
  readonly path: AbsolutePath;
  readonly checkScript?: string;
  readonly setupScript?: string;
}

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
   * the per-task sub-chain pulls the cwd / check-script / setup-script from the entry for the
   * task's repo so the implement chain works correctly on multi-repo projects.
   */
  readonly repositories: ReadonlyMap<RepositoryId, RepoExecConfig>;
  /** Absolute path to `<sprintDir>/progress.md`. Materialised by `ensureProgressFileLeaf`. */
  readonly progressFile: AbsolutePath;
  /**
   * Absolute path to `<sprintDir>` — the sprint's persisted-state folder. Used by
   * `buildTaskWorkspaceLeaf` to root the per-task `implement/<task-id>/` audit tree, and as
   * the lock key for the sprint-wide repo lock (a single implement run at a time across all
   * repos the sprint touches).
   */
  readonly sprintDir: AbsolutePath;
  /** Configured model for the implement chain — `config.ai.<provider>.models.implement`. */
  readonly model: string;
  /**
   * How preflight handles a dirty working tree. Default `'prompt'` — interactive recovery
   * (Keep / Stash / Reset / Cancel). Non-interactive callers (CI, headless harness) should
   * explicitly pass `'cancel'` or `'continue'`.
   */
  readonly dirtyTreePolicy?: DirtyTreePolicy;
}

/**
 * Build the implement chain. One invocation runs at most one attempt per task and transitions
 * the sprint into `review` once every todo task has settled.
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
 *         ensure-progress-file,
 *         setup-script-runner,
 *         resolve-branch,                  // assigns ralphctl/<id> on first run, persists, checks out
 *         preflight-task,                  // one-shot, before per-task subchains
 *         sequential('implement-tasks', [
 *           sequential('task-<id>', [
 *             branch-preflight-<id>,       // halt if working tree drifted off the sprint branch
 *             build-task-workspace-<id>,
 *             install-skills-<id>,         // → <sprintDir>/implement/<task-id>/.claude/skills/
 *             start-attempt-<id>,
 *             gen-eval-loop-<id>,
 *             commit-task-<id>,
 *             post-task-check,
 *             settle-attempt-<id>,
 *             uninstall-skills-<id>,
 *           ]),
 *           ...
 *         ]),
 *         save-tasks,
 *         transition-sprint-to-review,
 *       ])
 *     ),
 *   ])
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
 * - `task.maxAttempts` bounds attempts per task. The chain only runs ONE attempt per task per
 *   invocation; a task that settled `in_progress` (more attempts available) is picked up by
 *   re-running the chain.
 *
 * ## Progress file
 *
 * `<sprintDir>/progress.md` is the per-sprint shared learnings log. The chain caller resolves
 * the absolute path; `ensureProgressFileLeaf` materialises it if missing.
 */
export const createImplementFlow = (deps: ImplementDeps, opts: CreateImplementFlowOpts): Element<ImplementCtx> => {
  const readConfig = (): Promise<{ readonly maxTurns: number }> =>
    Promise.resolve({ maxTurns: deps.config.harness.maxTurns });

  // Resolve every task's repository config at construction time so per-task leaves can inject
  // the right `cwd` / `checkScript`. A task that references an unknown repo id is a planning
  // bug — fail loudly here rather than mid-run with a confusing "missing cwd" surface.
  const resolveRepo = (task: Task): RepoExecConfig => {
    const repo = opts.repositories.get(task.repositoryId);
    if (repo === undefined) {
      throw new InvalidStateError({
        entity: 'task',
        currentState: 'pre-implement',
        attemptedAction: 'resolve-repo',
        message: `task '${String(task.id)}' references repositoryId '${String(task.repositoryId)}' which is not in the project's repositories`,
      });
    }
    return repo;
  };

  // Unique set of repos the sprint's todo tasks touch. `resolve-branch` checks the sprint
  // branch out in each of these; `preflight-task` runs the dirty-tree gate once per repo.
  // (Setup scripts iterate the full project — see `opts.repositories` below.)
  const uniqueRepoCwds = ((): readonly AbsolutePath[] => {
    const seen = new Set<string>();
    const out: AbsolutePath[] = [];
    for (const task of opts.todoTasks) {
      const repo = resolveRepo(task);
      if (seen.has(String(repo.path))) continue;
      seen.add(String(repo.path));
      out.push(repo.path);
    }
    return out;
  })();

  // Fan-out signal stream — every signal emitted by the gen-eval leaves reaches the
  // existing harness sink (TUI / in-memory bus) AND lands in `<sprintDir>/progress.md`
  // under a colocated `.lock`. The progress sink is fire-and-forget on emit; the chain
  // flushes it on the way out via `flushProgressSinkLeaf` so the file is consistent
  // with everything the run emitted before the trace closes.
  const progressLockPath = AbsolutePath.parse(`${String(opts.progressFile)}.lock`);
  if (!progressLockPath.ok) throw progressLockPath.error;
  const progressSink = createProgressFileSink({
    progressFile: opts.progressFile,
    lockFile: progressLockPath.value,
    locker: deps.fileLocker,
    logger: deps.logger,
  });
  const signalsBroadcast = broadcastSink<HarnessSignal>([deps.signals, progressSink]);

  // `installSkillsLeaf` writes the bundled skill set to `<repo>/<parentDir>/skills/ralphctl-*/`.
  // Pointing it at `repo.path` is what makes per-repo project skills, `.mcp.json`, and the
  // provider-native context file (CLAUDE.md / .github/copilot-instructions.md / AGENTS.md)
  // visible to the running AI — those are only auto-discovered from cwd, not from `--add-dir`
  // roots. The `ralphctl-` prefix + the wildcard line the skills adapter appends to
  // `.git/info/exclude` keeps the harness-authored copies out of the user's git tree.
  const repoCwdPicker = (repoPath: AbsolutePath) => (): AbsolutePath => repoPath;

  const perTaskSubChain = (task: Task): Element<ImplementCtx> => {
    const taskId = task.id;
    const repo = resolveRepo(task);
    const genEvalLeafDeps = {
      provider: deps.provider,
      templateLoader: deps.templateLoader,
      signals: signalsBroadcast,
      cwd: repo.path,
      model: opts.model,
      clock: deps.clock,
      logger: deps.logger,
      eventBus: deps.eventBus,
      maxTurns: deps.config.harness.maxTurns,
      ...(repo.checkScript !== undefined ? { checkScript: repo.checkScript } : {}),
    };
    return sequential<ImplementCtx>(`task-${String(taskId)}`, [
      branchPreflightLeaf(
        { gitRunner: deps.gitRunner, logger: deps.logger },
        { cwd: repo.path },
        `branch-preflight-${String(taskId)}`
      ),
      buildTaskWorkspaceLeaf(
        { templateLoader: deps.templateLoader, logger: deps.logger },
        {
          sprintDir: opts.sprintDir,
          cwd: repo.path,
          progressFile: opts.progressFile,
          ...(repo.checkScript !== undefined ? { checkScript: repo.checkScript } : {}),
        },
        taskId
      ),
      installSkillsLeaf<ImplementCtx>(
        { skillsAdapter: deps.skillsAdapter, skillSource: deps.skillSource },
        { name: `install-skills-${String(taskId)}`, flowId: 'implement', cwdPicker: repoCwdPicker(repo.path) }
      ),
      startAttemptLeaf({ taskRepo: deps.taskRepo, clock: deps.clock, logger: deps.logger }, taskId),
      // Composite: per-turn generator + evaluator, repeated until a terminal exit is set on ctx
      // or the configured `maxTurns` budget is hit. The evaluator is guarded — if the generator
      // self-blocked this turn it set `lastExit` and the evaluator must not run.
      loop<ImplementCtx>(
        `gen-eval-${String(taskId)}`,
        sequential<ImplementCtx>(`gen-eval-turn-${String(taskId)}`, [
          generatorLeaf(genEvalLeafDeps, taskId),
          guard<ImplementCtx>(
            `evaluator-guard-${String(taskId)}`,
            (ctx) => ctx.lastExit === undefined,
            evaluatorLeaf(genEvalLeafDeps, taskId)
          ),
        ]),
        {
          shouldContinue: async (_ctx, i) => {
            const cfg = await readConfig();
            return i <= Math.max(1, cfg.maxTurns);
          },
          shouldStop: (ctx) => ctx.lastExit !== undefined,
        }
      ),
      finalizeGenEvalLeaf({ taskRepo: deps.taskRepo, readConfig, logger: deps.logger }, taskId),
      // Verify gate sits BEFORE commit so a red checkScript blocks the task instead of landing
      // broken code on the sprint branch. On `verify-failed` the leaf stamps `lastBlockReason`,
      // the guard around `commit-task` skips, and `settle-attempt` marks the task `blocked`.
      // The AI is told to run the verify script itself via the prompt; this leaf is the
      // harness-side enforcement.
      postTaskCheckLeaf(
        { shellScriptRunner: deps.shellScriptRunner, logger: deps.logger },
        { cwd: repo.path, ...(repo.checkScript !== undefined ? { checkScript: repo.checkScript } : {}) },
        taskId
      ),
      guard<ImplementCtx>(
        `commit-task-guard-${String(taskId)}`,
        (ctx) => ctx.lastBlockReason === undefined,
        commitTaskLeaf(
          {
            gitRunner: deps.gitRunner,
            taskRepo: deps.taskRepo,
            clock: deps.clock,
            logger: deps.logger,
            signals: deps.signals,
          },
          { cwd: repo.path },
          taskId
        )
      ),
      settleAttemptLeaf(
        { taskRepo: deps.taskRepo, clock: deps.clock, logger: deps.logger, gitRunner: deps.gitRunner },
        { cwd: repo.path },
        taskId
      ),
      uninstallSkillsLeaf<ImplementCtx>(
        { skillsAdapter: deps.skillsAdapter },
        { name: `${IMPLEMENT_TASK_TERMINAL_LEAF}-${String(taskId)}`, cwdPicker: repoCwdPicker(repo.path) }
      ),
    ]);
  };

  const perTaskChains = opts.todoTasks.map((task) => perTaskSubChain(task));

  // Setup scripts run unconditionally at sprint-start across EVERY repo on the project (not
  // just the task-touched subset). The leaf iterates `opts.repositories` and appends one
  // structured audit row to `execution.setupRanAt` per repo per run — `'success'`,
  // `'failed'`, `'spawn-error'`, or `'skipped'` (no script configured). A `'failed'` or
  // `'spawn-error'` outcome hard-aborts the chain before any task spins up; the AI may also
  // run setup commands itself, but the harness is the authoritative readiness gate.
  const setupRepoEntries = Array.from(opts.repositories.entries()).map(([id, r]) => ({
    repositoryId: id,
    path: r.path,
    ...(r.setupScript !== undefined ? { setupScript: r.setupScript } : {}),
  }));

  // Per-repo dirty-tree preflight. Each affected repo gets its own check so a clean
  // working tree in one repo doesn't mask a dirty tree in another. Default to 'prompt' here
  // so the interactive recovery menu (Keep / Stash / Reset / Cancel) fires; the business-layer
  // default stays 'cancel' for non-interactive callers in isolation.
  const dirtyTreePolicy: DirtyTreePolicy = opts.dirtyTreePolicy ?? 'prompt';
  const preflightLeaves = uniqueRepoCwds.map((cwd, i) =>
    preflightTaskLeaf(
      {
        gitRunner: deps.gitRunner,
        interactive: deps.interactive,
        clock: deps.clock,
        logger: deps.logger,
        dirtyTreePolicy,
      },
      cwd,
      `preflight-task-${String(i + 1)}-${String(cwd)}`
    )
  );

  const inner = sequential<ImplementCtx>('implement-locked', [
    loadAndAssertSprintSubChain<ImplementCtx>({ sprintRepo: deps.sprintRepo }, ['planned', 'active']),
    activateSprintLeaf({ sprintRepo: deps.sprintRepo, clock: deps.clock, logger: deps.logger }),
    loadSprintExecutionLeaf<ImplementCtx>({ sprintExecutionRepo: deps.sprintExecutionRepo }),
    loadTasksLeaf<ImplementCtx>({ taskRepo: deps.taskRepo }),
    ensureProgressFileLeaf(opts.progressFile),
    setupScriptRunnerLeaf(
      {
        shellScriptRunner: deps.shellScriptRunner,
        clock: deps.clock,
        eventBus: deps.eventBus,
        sprintExecutionRepo: deps.sprintExecutionRepo,
        logger: deps.logger,
      },
      { repos: setupRepoEntries }
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
    sequential<ImplementCtx>('preflight-tasks', preflightLeaves),
    sequential<ImplementCtx>('implement-tasks', perTaskChains),
    saveTasksLeaf<ImplementCtx>({ taskRepo: deps.taskRepo }),
    // Only transition to review when at least one task actually settled `done`. If every task
    // got blocked (e.g. pre-existing build failure, repeated self-block), the sprint has
    // nothing to review — leaving it `active` lets the user fix the blocker and re-run
    // implement without first manually backing the sprint out of review. Mixed runs (some
    // done, some blocked) still transition: there's real work to review.
    guard<ImplementCtx>(
      'transition-sprint-to-review-when-any-done',
      (ctx) => ctx.tasks?.some((t) => t.status === 'done') === true,
      transitionSprintToReviewLeaf({ sprintRepo: deps.sprintRepo, clock: deps.clock, logger: deps.logger })
    ),
    flushProgressSinkLeaf(progressSink),
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
