import type { Task } from '@src/domain/entity/task.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { Slug } from '@src/domain/value/slug.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { Element } from '@src/application/chain/element.ts';
import { guard } from '@src/application/chain/build/guard.ts';
import { loop } from '@src/application/chain/build/loop.ts';
import { sequential } from '@src/application/chain/build/sequential.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import type { ImplementDeps } from '@src/application/flows/implement/deps.ts';
import { buildAttemptBody, type AttemptReadConfig } from '@src/application/flows/implement/leaves/attempt-body.ts';
import { branchPreflightLeaf } from '@src/application/flows/implement/leaves/branch-preflight.ts';
import { buildTaskWorkspaceLeaf } from '@src/application/flows/implement/leaves/build-task-workspace.ts';
import { dependencyGateLeaf, isTaskRunnable } from '@src/application/flows/implement/leaves/dependency-gate.ts';
import type { GenEvalLoopRoleConfig } from '@src/application/flows/implement/leaves/gen-eval-loop.ts';
import {
  isSettledBlocked,
  quarantineBlockedDiffLeaf,
} from '@src/application/flows/implement/leaves/quarantine-blocked-diff.ts';
import {
  clearReproductionArtifactLeaf,
  isDefectShapedTask,
  reproduceLeaf,
} from '@src/application/flows/implement/leaves/reproduce.ts';
import type { RepoExecConfig } from '@src/application/flows/implement/leaves/resolve-repo.ts';
import { installSkillsLeaf } from '@src/application/flows/_shared/skills/install-skills.ts';
import { uninstallSkillsLeaf } from '@src/application/flows/_shared/skills/uninstall-skills.ts';
import { installAgentDefinitionsLeaf } from '@src/application/flows/_shared/agents/install-agent-definitions.ts';
import { uninstallAgentDefinitionsLeaf } from '@src/application/flows/_shared/agents/uninstall-agent-definitions.ts';
import type { AgentDefinition } from '@src/integration/ai/agents/_engine/agent-definition.ts';

/**
 * Per-task subchain factory. Returns the `sequential('task-<id>', [...])` element that runs the
 * complete lifecycle for ONE task.
 *
 * The shape is a dependency gate + a guarded body (once-per-task prologue + inner attempt loop +
 * once-per-task epilogue):
 *
 *   dependency-gate →                                                // block-upstream-if prereq ≠ done
 *   guard('task-runnable-<id>', sequential('task-body-<id>', [       // body runs only when runnable
 *     branch-preflight → workspace build → install-skills →          // once per task
 *     reset-reproduction → guard('reproduce-guard-<id>', reproduce)  // once per task, defect-shaped only
 *     loop('task-attempts-<id>', buildAttemptBody(…),                // up to maxAttempts attempts
 *          { maxIterations: maxAttempts, shouldStop: terminal }) →
 *     quarantine-blocked-diff (guarded, serial-path only) →          // once per task
 *     uninstall-skills                                               // once per task
 *   ]))
 *
 * `buildAttemptBody` (see `attempt-body.ts`) is the per-attempt segment the loop re-enters.
 *
 * The leading `dependency-gate` is the blocked-dependency dead-end fix: if any `dependsOn` task
 * is not `done`, it transitions this task to `blocked upstream …` and the `task-runnable` guard
 * skips the entire body — so a dependent never spawns the generator against a tree missing its
 * prerequisite's work (which used to self-block and ship the sprint partial).
 *
 * The terminal `uninstall-skills` leaf name is the value of {@link IMPLEMENT_TASK_TERMINAL_LEAF}
 * exported from `flow.ts` and is what the TUI's task-completion detector keys on — it stays
 * OUTSIDE the attempt loop so it fires exactly once per task regardless of attempt count.
 *
 * ## Inner attempt loop
 *
 * A single launch now runs up to the effective `maxAttempts` (the task's own cap when stamped at
 * plan time, else the configured `settings.harness.maxAttempts` fallback for legacy tasks) attempts
 * per task instead of one. The outer `loop` re-enters the attempt segment until
 * {@link terminalTaskStatus} reports the just-settled task is `done` or `blocked`, or the
 * `maxIterations` cap fires (the loop primitive's 1000 ceiling is only a backstop). When the
 * effective cap is `1` the loop runs exactly one iteration — the single-attempt-per-launch
 * behaviour is byte-for-byte preserved for that case.
 *
 * The escalation path is what makes a second iteration productive: on a plateau / budget-exhausted
 * exit with `escalateOnPlateau` on and budget remaining, `settle-attempt` keeps the task
 * `in_progress` (escalated generator model stamped), `terminalTaskStatus` returns false, and the
 * loop re-runs `start-attempt`, which opens a fresh attempt that the next generator turn runs on
 * the upgraded model. A budget-exhausted task is never silently dropped: rather than spending the
 * final attempt and relying on `failCurrentAttempt`'s blocked-at-cap branch (which the escalation
 * path never reaches — `decideEscalation` PRE-EMPTS at the cap, returning `budget-exhausted` and
 * settling the work `done`-with-warning), the policy stops granting retries once the effective
 * `maxAttempts` is reached and the loop exits on the resulting terminal status.
 *
 * `branch-preflight` / `build-task-workspace` / `install-skills` / `uninstall-skills` are
 * deliberately OUTSIDE the loop: they are per-task setup/teardown, not per-attempt work, and
 * re-running them every attempt would re-install skills and rebuild the workspace needlessly.
 *
 * Verify gate sits BEFORE commit so a red verifyScript blocks the task instead of landing
 * broken code on the sprint branch. On `verify-failed` the leaf stamps `lastBlockReason`,
 * the guard around `commit-task` skips, and `settle-attempt` marks the task `blocked` — UNLESS
 * the failure is a `'regressed'` attribution (green baseline broken) AND attempt budget remains:
 * then the leaf ALSO stamps `lastShouldFailAttempt`, settle's precedence keeps the task
 * `in_progress`, the rejected diff is quarantined, and the loop re-enters with the failing
 * post-verify output threaded into the next generator prompt (T6). Only on budget exhaustion does
 * a regressed verify block.
 *
 * Intermediate commits from earlier attempts are KEPT when a later attempt blocks the task —
 * deliberate asymmetry with the quarantine: each such commit passed its own post-verify green
 * (the never-commit-on-red guard), so resetting history would discard verified work the operator
 * may want. Only the final blocked attempt's uncommitted diff is quarantined.
 *
 * Continue-on-blocked: tasks that settle `blocked` (self-block reason) do NOT halt the chain —
 * sibling tasks run unconditionally. The settle-attempt leaf catches the block, the chain
 * keeps going. On the serial path the guarded `quarantine-blocked-diff` leaf then stashes the
 * blocked task's rejected diff (which the settle guardrail deliberately left in the shared tree)
 * so the next sibling starts on a clean tree instead of inheriting — and committing — the leftovers.
 *
 * AbortError propagates verbatim through the attempt loop: a mid-attempt abort fails the inner
 * sequential, the loop returns the `AbortError` without starting another iteration.
 */
export interface PerTaskSubchainOpts {
  readonly sprintDir: AbsolutePath;
  readonly progressFile: AbsolutePath;
  readonly terminalLeafName: string;
  readonly generator: GenEvalLoopRoleConfig;
  readonly evaluator: GenEvalLoopRoleConfig;
  /**
   * `<dataRoot>/memory` — durable, project-scoped learnings root. Threaded into the
   * `append-learnings-<taskId>` leaf so each attempt's `<learning>` signals land in the project
   * ledger at `<memoryRoot>/<projectId>/learnings.ndjson`.
   */
  readonly memoryRoot: AbsolutePath;
  /** Owning project's id — selects the per-project learnings ledger subdirectory. */
  readonly projectId: string;
  /** Owning project's slug — builds the human-readable `<id>--<slug>/` ledger subdirectory. */
  readonly projectSlug: Slug;
  /**
   * Whether the per-task prologue includes the `branch-preflight-<taskId>` leaf. Default `true`
   * (the serial implement path: every per-task sub-chain re-asserts the working tree is on the
   * resolved sprint branch before committing, so an AI generator turn that `git checkout`-ed away
   * can't land a wrong-branch commit).
   *
   * The parallel launcher sets this `false`: each task runs in its own git worktree checked
   * out on a dedicated `ralphctl/<sprintId>/wt-<taskId>` ref, so there is no shared sprint branch
   * to drift FROM. A preflight there would compare against the wrong ref and fail spuriously —
   * branch enforcement is moot per-worktree, the fold step is what lands commits on the shared
   * sprint branch.
   */
  readonly includeBranchPreflight?: boolean;
  /**
   * Generator-role's bound agent definition, resolved once at launch — `undefined` when the
   * role has no binding (or the bound name didn't resolve, AC2). Installed into `repo.path`
   * once per task, alongside the bundled skills, and removed at the terminal leaf. Spliced
   * conditionally: an unbound role gets no install/uninstall leaves at all, so its session
   * trace is byte-for-byte unaffected.
   */
  readonly generatorAgentDefinition?: AgentDefinition;
  /** Evaluator-role's bound agent definition — same lifecycle as {@link generatorAgentDefinition}. */
  readonly evaluatorAgentDefinition?: AgentDefinition;
}

// `installSkillsLeaf` writes the bundled skill set to `<repo>/<parentDir>/skills/ralphctl-*/`.
// Pointing it at `repo.path` is what makes per-repo project skills, `.mcp.json`, and the
// provider-native context file (CLAUDE.md / .github/copilot-instructions.md / AGENTS.md)
// visible to the running AI — those are only auto-discovered from cwd, not from `--add-dir`
// roots. The `ralphctl-` prefix + the wildcard line the skills adapter appends to
// `.git/info/exclude` keeps the harness-authored copies out of the user's git tree.
const repoCwdPicker = (repoPath: AbsolutePath) => (): AbsolutePath => repoPath;

/**
 * Per-role agent-definition install leaves — spliced ONLY when that role has a bound definition
 * (AC2/AC3): an unbound role never gets these leaves, so its session trace is unaffected. Kept as
 * a helper (rather than inline per-role conditional spreads) so `createPerTaskSubchain` itself
 * stays under the project's cognitive-complexity ratchet.
 */
const buildAgentDefinitionInstallLeaves = (
  deps: ImplementDeps,
  opts: PerTaskSubchainOpts,
  repo: RepoExecConfig,
  taskId: TaskId
): Array<Element<ImplementCtx>> => {
  const leaves: Array<Element<ImplementCtx>> = [];
  if (opts.generatorAgentDefinition !== undefined) {
    leaves.push(
      installAgentDefinitionsLeaf<ImplementCtx>(
        { agentDefinitionAdapter: deps.generatorAgentDefinitionAdapter },
        {
          name: `install-generator-agent-definition-${String(taskId)}`,
          definition: opts.generatorAgentDefinition,
          cwdPicker: repoCwdPicker(repo.path),
        }
      )
    );
  }
  if (opts.evaluatorAgentDefinition !== undefined) {
    leaves.push(
      installAgentDefinitionsLeaf<ImplementCtx>(
        { agentDefinitionAdapter: deps.evaluatorAgentDefinitionAdapter },
        {
          name: `install-evaluator-agent-definition-${String(taskId)}`,
          definition: opts.evaluatorAgentDefinition,
          cwdPicker: repoCwdPicker(repo.path),
        }
      )
    );
  }
  return leaves;
};

/**
 * Reproduction-first leaves (once per task, not per attempt): an unconditional reset followed by
 * a guarded headless AI session that, for a defect-shaped task, writes + runs one failing test
 * demonstrating the reported defect BEFORE any generator turn spawns — so round 1 already has a
 * verified reproduction to make pass instead of discovering the defect from prose alone. The
 * guard skips silently for every other task kind (no AI spawn). Sits before the attempt loop
 * rather than inside it: the reproduction does not change across retries of the SAME task, so
 * re-running it every attempt would just re-pay the spawn cost for an identical artifact.
 *
 * The reset MUST run first, every task, regardless of task kind: the guarded leaf only ever
 * WRITES a fresh artifact (or nothing), so without it a defect-shaped task's validated artifact
 * would leak unchanged into a later non-defect task of the same serial run — see
 * `clearReproductionArtifactLeaf`'s docstring. Kept as a helper (like the agent-definition
 * install/uninstall pairs above) so `createPerTaskSubchain` stays under the complexity ratchet.
 * See `reproduce.ts` for the failure-tolerance and harness-side re-run verification the guarded
 * leaf performs before accepting an artifact.
 *
 * These leaves run BEFORE the attempt `loop` below, so the reproduce leaf's deliberately-failing
 * test is already sitting uncommitted in the tree by the time the first attempt's
 * `pre-task-verify` runs. That is safe ONLY because `pre-task-verify` excludes the reproduction
 * test's own path from its baseline gate run on every attempt (see `withReproductionTestExcluded`
 * in `pre-task-verify-internals/verify-execution.ts`) — without that exclusion the harness's own
 * fixture would masquerade as a pre-existing broken baseline (`attributeVerify` → always
 * `'baseline-broken'`), defeating never-commit-on-red for every defect-shaped task.
 */
const buildReproduceLeaves = (
  deps: ImplementDeps,
  opts: PerTaskSubchainOpts,
  repo: RepoExecConfig,
  taskId: TaskId
): Array<Element<ImplementCtx>> => [
  clearReproductionArtifactLeaf(taskId),
  guard<ImplementCtx>(
    `reproduce-guard-${String(taskId)}`,
    (ctx) => isDefectShapedTask(ctx, taskId),
    reproduceLeaf(
      {
        provider: deps.generatorProvider,
        templateLoader: deps.templateLoader,
        publishSignal: deps.publishSignal,
        shellScriptRunner: deps.shellScriptRunner,
        logger: deps.logger,
      },
      {
        cwd: repo.path,
        progressFile: opts.progressFile,
        model: opts.generator.model,
        ...(opts.generator.effort !== undefined ? { effort: opts.generator.effort } : {}),
      },
      taskId
    )
  ),
];

/** Uninstall-side counterpart of {@link buildAgentDefinitionInstallLeaves} — same per-role gate. */
const buildAgentDefinitionUninstallLeaves = (
  deps: ImplementDeps,
  opts: PerTaskSubchainOpts,
  repo: RepoExecConfig,
  taskId: TaskId
): Array<Element<ImplementCtx>> => {
  const leaves: Array<Element<ImplementCtx>> = [];
  if (opts.generatorAgentDefinition !== undefined) {
    leaves.push(
      uninstallAgentDefinitionsLeaf<ImplementCtx>(
        { agentDefinitionAdapter: deps.generatorAgentDefinitionAdapter },
        { name: `uninstall-generator-agent-definition-${String(taskId)}`, cwdPicker: repoCwdPicker(repo.path) }
      )
    );
  }
  if (opts.evaluatorAgentDefinition !== undefined) {
    leaves.push(
      uninstallAgentDefinitionsLeaf<ImplementCtx>(
        { agentDefinitionAdapter: deps.evaluatorAgentDefinitionAdapter },
        { name: `uninstall-evaluator-agent-definition-${String(taskId)}`, cwdPicker: repoCwdPicker(repo.path) }
      )
    );
  }
  return leaves;
};

/**
 * Pure predicate read by the attempt loop's `shouldStop`. Looks up the task in `ctx.tasks` (the
 * settled copy `settle-attempt` writes back after each attempt) and reports whether it reached a
 * terminal status — `done` or `blocked`. A task left `in_progress` (escalation retry) or `todo`
 * (never reached, defensive) is non-terminal, so the loop runs another attempt up to the cap.
 *
 * Defensive on a missing task: an id absent from `ctx.tasks` is treated as terminal so the loop
 * exits rather than spinning — a missing settled task means an upstream leaf failed to write the
 * transition, which the per-attempt leaves' own guards already surface.
 */
export const terminalTaskStatus = (ctx: ImplementCtx, taskId: TaskId): boolean => {
  const task = ctx.tasks?.find((t) => t.id === taskId);
  if (task === undefined) return true;
  return task.status === 'done' || task.status === 'blocked';
};

export const createPerTaskSubchain = (
  deps: ImplementDeps,
  opts: PerTaskSubchainOpts,
  task: Task,
  repo: RepoExecConfig,
  readConfig: AttemptReadConfig
): Element<ImplementCtx> => {
  const taskId = task.id;
  // The serial path keeps `branch-preflight` (default true) so a wrong-branch commit never lands;
  // the parallel launcher omits it (each task runs in its own dedicated worktree ref). Spliced via
  // a conditional spread so the serial element tree is byte-for-byte unchanged when included.
  const includeBranchPreflight = opts.includeBranchPreflight ?? true;
  // Effective per-task attempt cap — the task's own `maxAttempts` (stamped at plan time, validated
  // 1–10) or the configured `settings.harness.maxAttempts` fallback for legacy tasks. Computed ONCE
  // here so BOTH the outer attempt loop's `maxIterations` (below) AND `post-task-verify`'s
  // red-post-verify retry budget (T6) read the same value — the leaf and the loop can never
  // disagree about which attempt the budget runs out on.
  const effectiveMaxAttempts = task.maxAttempts ?? deps.config.harness.maxAttempts;
  return sequential<ImplementCtx>(`task-${String(taskId)}`, [
    // Dependency gate (blocked-dependency dead-end fix). Runs FIRST: if any `dependsOn` task is
    // not `done`, it transitions this task straight to `blocked upstream …` and the body guard
    // below skips the whole lifecycle — so a dependent never spawns the generator against a tree
    // missing its prerequisite's work. Transitive by construction (A blocks → B → C …).
    dependencyGateLeaf({ taskRepo: deps.taskRepo, logger: deps.logger }, taskId),
    guard<ImplementCtx>(
      `task-runnable-${String(taskId)}`,
      (ctx) => isTaskRunnable(ctx, taskId),
      sequential<ImplementCtx>(`task-body-${String(taskId)}`, [
        ...(includeBranchPreflight
          ? [
              branchPreflightLeaf(
                { gitRunner: deps.gitRunner, logger: deps.logger },
                { cwd: repo.path },
                `branch-preflight-${String(taskId)}`
              ),
            ]
          : []),
        buildTaskWorkspaceLeaf(
          { templateLoader: deps.templateLoader, logger: deps.logger, writeFile: deps.writeFile },
          {
            sprintDir: opts.sprintDir,
            cwd: repo.path,
            progressFile: opts.progressFile,
            ...(repo.verifyScript !== undefined ? { verifyScript: repo.verifyScript } : {}),
          },
          taskId
        ),
        installSkillsLeaf<ImplementCtx>(
          { skillsAdapter: deps.skillsAdapter, skillSource: deps.skillSource },
          { name: `install-skills-${String(taskId)}`, flowId: 'implement', cwdPicker: repoCwdPicker(repo.path) }
        ),
        // Per-role agent-definition install — see {@link buildAgentDefinitionInstallLeaves}.
        ...buildAgentDefinitionInstallLeaves(deps, opts, repo, taskId),
        // Reproduction-first — see {@link buildReproduceLeaves}.
        ...buildReproduceLeaves(deps, opts, repo, taskId),
        // Inner attempt loop. The body is the full per-attempt segment; the loop re-enters it
        // until `terminalTaskStatus` reports the settled task `done`/`blocked` or the `maxAttempts`
        // cap fires. `maxAttempts === 1` runs exactly once (single-attempt-per-launch parity); a
        // higher cap only manifests on the escalation-retry path. The 1000 ceiling on the `loop`
        // primitive is just a backstop — `maxAttempts` (validated 1–10) is the real bound here.
        loop<ImplementCtx>(
          `task-attempts-${String(taskId)}`,
          buildAttemptBody(deps, opts, task, repo, readConfig, effectiveMaxAttempts),
          {
            // The attempt count is bounded by the task's own `maxAttempts` (validated 1–10), or the
            // configured `settings.harness.maxAttempts` fallback for legacy tasks planned before the
            // field existed (mirrors the budget fallback in `finalize-gen-eval`/`decideEscalation`,
            // so a legacy task's loop cap and its escalation budget agree). The domain's
            // `failCurrentAttempt` still transitions the task to `blocked` once attempts hit the
            // cap, so a budget-exhausted task is never silently dropped — `shouldStop` just
            // recognises that terminal status and exits.
            maxIterations: effectiveMaxAttempts,
            shouldStop: (ctx) => terminalTaskStatus(ctx, taskId),
          }
        ),
        // SERIAL-PATH ONLY. A task that settled `blocked` (self-block / budget-exhausted) leaves its
        // rejected diff in the SHARED worktree — `settle-attempt`'s dirty-tree guardrail exempts the
        // block path so the operator can inspect it. On the serial path that contaminates the next
        // task (its `git add -A` sweeps the leftovers into its commit; the dirt flips its pre-verify
        // red and the red post-verify is mis-attributed `baseline-broken`, landing a corrupt commit).
        // This guarded leaf stashes the rejected diff so the tree is clean again before the next task
        // runs, restoring the invariant the prologue's one-shot preflight assumes. The guard is
        // synchronous (status === 'blocked' read from the settled `ctx.tasks` copy — `settle-attempt`
        // cleared `ctx.currentTask`); the splice itself is gated on the serial-path proxy
        // `includeBranchPreflight` so the parallel launcher (per-task worktrees, already isolated)
        // never includes it. Stays INSIDE the body guard + AFTER the loop so it runs once per task,
        // and BEFORE `uninstall-skills` so that leaf remains the subchain's terminal element (the
        // TUI's task-completion detector keys on it).
        ...(includeBranchPreflight
          ? [
              guard<ImplementCtx>(
                `quarantine-blocked-diff-guard-${String(taskId)}`,
                (ctx) => isSettledBlocked(ctx, taskId),
                quarantineBlockedDiffLeaf(
                  {
                    gitRunner: deps.gitRunner,
                    taskRepo: deps.taskRepo,
                    appendFile: deps.appendFile,
                    logger: deps.logger,
                  },
                  { cwd: repo.path, progressFile: opts.progressFile },
                  taskId
                )
              ),
            ]
          : []),
        // Per-role agent-definition uninstall — see {@link buildAgentDefinitionUninstallLeaves}.
        // MUST run before the terminal `uninstall-skills` leaf below so that leaf stays the
        // subchain's last element (the TUI's task-completion detector keys on it).
        ...buildAgentDefinitionUninstallLeaves(deps, opts, repo, taskId),
        uninstallSkillsLeaf<ImplementCtx>(
          { skillsAdapter: deps.skillsAdapter },
          { name: `${opts.terminalLeafName}-${String(taskId)}`, cwdPicker: repoCwdPicker(repo.path) }
        ),
      ])
    ),
  ]);
};
