import type { Task } from '@src/domain/entity/task.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { Slug } from '@src/domain/value/slug.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { type Element, withDisplay } from '@src/application/chain/element.ts';
import { guard } from '@src/application/chain/build/guard.ts';
import { loop } from '@src/application/chain/build/loop.ts';
import { sequential } from '@src/application/chain/build/sequential.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import type { ImplementDeps } from '@src/application/flows/implement/deps.ts';
import { buildAttemptBody, type AttemptReadConfig } from '@src/application/flows/implement/leaves/attempt-body.ts';
import { branchPreflightLeaf } from '@src/application/flows/implement/leaves/branch-preflight.ts';
import { buildTaskWorkspaceLeaf } from '@src/application/flows/implement/leaves/build-task-workspace.ts';
import { dependencyGateLeaf, isTaskRunnable } from '@src/application/flows/implement/leaves/dependency-gate.ts';
import { resumeBudgetGateLeaf } from '@src/application/flows/implement/leaves/resume-budget-gate.ts';
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
 * The per-task subchain's terminal leaf; the TUI's task bucketing reads it as "this task is fully
 * settled", so it must stay the subchain's last element.
 */
export const IMPLEMENT_TASK_TERMINAL_LEAF = 'uninstall-skills';

/**
 * Per-task subchain — the complete lifecycle of ONE task:
 *
 *   dependency-gate → resume-budget-gate →
 *   guard('task-runnable-<id>', sequential('task-body-<id>', [
 *     branch-preflight (serial only) → build-task-workspace → install-skills → install agent defs →
 *     reset-reproduction → guard(reproduce) →
 *     loop('task-attempts-<id>', buildAttemptBody(…), { maxIterations: maxAttempts, shouldStop: terminal }) →
 *     guard(quarantine-blocked-diff) (serial only) → uninstall agent defs → uninstall-skills
 *   ]))
 *
 * Setup and teardown sit outside the attempt loop so they run once per task. A task that settles
 * `blocked` does not halt the chain; sibling tasks keep running. AbortError propagates verbatim.
 */
export interface PerTaskSubchainOpts {
  readonly sprintDir: AbsolutePath;
  readonly progressFile: AbsolutePath;
  readonly generator: GenEvalLoopRoleConfig;
  readonly evaluator: GenEvalLoopRoleConfig;
  /** `<dataRoot>/memory` — root of the per-project learnings ledger. */
  readonly memoryRoot: AbsolutePath;
  readonly projectId: string;
  readonly projectSlug: Slug;
  /**
   * The task runs in its own git worktree (the parallel path). That drops `branch-preflight` — a
   * worktree is on its own `ralphctl-wt/…` ref, so there is no shared branch to drift from — and
   * the in-chain `quarantine-blocked-diff`, which `worktree-teardown.ts` runs before removing the
   * worktree instead.
   */
  readonly worktree?: boolean;
  /** Bound agent definitions, installed into the repo once per task; an unbound role gets no leaves. */
  readonly generatorAgentDefinition?: AgentDefinition;
  readonly evaluatorAgentDefinition?: AgentDefinition;
}

// Skills and agent definitions install into the repo itself: CLIs discover them (and the repo's
// context file / `.mcp.json`) only from cwd, not from `--add-dir` roots.
const repoCwdPicker = (repoPath: AbsolutePath) => (): AbsolutePath => repoPath;

/** Install / uninstall leaves for each role that has a bound agent definition. */
const agentDefinitionLeaves = (
  phase: 'install' | 'uninstall',
  deps: ImplementDeps,
  opts: PerTaskSubchainOpts,
  repo: RepoExecConfig,
  taskId: TaskId
): Array<Element<ImplementCtx>> =>
  (['generator', 'evaluator'] as const).flatMap((role) => {
    const definition = role === 'generator' ? opts.generatorAgentDefinition : opts.evaluatorAgentDefinition;
    if (definition === undefined) return [];
    const agentDefinitionAdapter =
      role === 'generator' ? deps.generatorAgentDefinitionAdapter : deps.evaluatorAgentDefinitionAdapter;
    const name = `${phase}-${role}-agent-definition-${String(taskId)}`;
    const cwdPicker = repoCwdPicker(repo.path);
    return [
      phase === 'install'
        ? installAgentDefinitionsLeaf<ImplementCtx>({ agentDefinitionAdapter }, { name, definition, cwdPicker })
        : uninstallAgentDefinitionsLeaf<ImplementCtx>({ agentDefinitionAdapter }, { name, cwdPicker }),
    ];
  });

/**
 * Reproduction-first (once per task): for a defect-shaped task, one guarded AI session writes and
 * runs a failing test before round 1. The reset runs for EVERY task so a prior task's artifact
 * never leaks into the next one on the serial path.
 *
 * Hazard: the failing test is uncommitted in the tree when the first `pre-task-verify` runs. That
 * is safe only because `pre-task-verify` excludes its path from the baseline run
 * (`withReproductionTestExcluded`); otherwise every defect-shaped task would read as
 * `baseline-broken`. On a relaunch whose earlier work sits in the quarantine stash, the leaf reuses
 * the saved reproduction instead (its test is in that stash).
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
        gitRunner: deps.gitRunner,
        writeFile: deps.writeFile,
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

/**
 * Run before the `task-runnable` guard: a `blocked` prerequisite blocks this task `blocked
 * upstream …` (so it never runs on a tree missing that work), and a resume that would exhaust the
 * attempt budget blocks here instead of failing `start-attempt` and ending a serial run.
 */
const buildTaskGates = (deps: ImplementDeps, taskId: TaskId): Array<Element<ImplementCtx>> => [
  dependencyGateLeaf({ taskRepo: deps.taskRepo, logger: deps.logger }, taskId),
  resumeBudgetGateLeaf(
    { taskRepo: deps.taskRepo, clock: deps.clock, logger: deps.logger, eventBus: deps.eventBus },
    taskId
  ),
];

/**
 * The attempt loop's `shouldStop`: the settled copy in `ctx.tasks` is `done` or `blocked`. A
 * missing task counts as terminal so the loop exits rather than spinning.
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
  const serial = opts.worktree !== true;
  // One value for both the loop cap and post-task-verify's retry budget, so they never disagree.
  const effectiveMaxAttempts = task.maxAttempts ?? deps.config.harness.maxAttempts;
  const subchain = sequential<ImplementCtx>(`task-${String(taskId)}`, [
    ...buildTaskGates(deps, taskId),
    guard<ImplementCtx>(
      `task-runnable-${String(taskId)}`,
      (ctx) => isTaskRunnable(ctx, taskId),
      sequential<ImplementCtx>(`task-body-${String(taskId)}`, [
        ...(serial
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
        ...agentDefinitionLeaves('install', deps, opts, repo, taskId),
        ...buildReproduceLeaves(deps, opts, repo, taskId),
        loop<ImplementCtx>(
          `task-attempts-${String(taskId)}`,
          buildAttemptBody(deps, opts, task, repo, readConfig, effectiveMaxAttempts),
          {
            maxIterations: effectiveMaxAttempts,
            shouldStop: (ctx) => terminalTaskStatus(ctx, taskId),
            label: 'Attempt',
          }
        ),
        // Serial path only: a blocked task leaves its rejected diff in the shared tree, which the
        // next task would sweep into its commit, so stash it first. The parallel path quarantines
        // in `worktree-teardown.ts` instead.
        ...(serial
          ? [
              guard<ImplementCtx>(
                `quarantine-blocked-diff-guard-${String(taskId)}`,
                (ctx) => isSettledBlocked(ctx, taskId),
                quarantineBlockedDiffLeaf(
                  {
                    gitRunner: deps.gitRunner,
                    taskRepo: deps.taskRepo,
                    appendFile: deps.appendFile,
                    journalMutex: deps.journalMutex,
                    logger: deps.logger,
                  },
                  { cwd: repo.path, progressFile: opts.progressFile },
                  taskId
                )
              ),
            ]
          : []),
        ...agentDefinitionLeaves('uninstall', deps, opts, repo, taskId),
        uninstallSkillsLeaf<ImplementCtx>(
          { skillsAdapter: deps.skillsAdapter },
          { name: `${IMPLEMENT_TASK_TERMINAL_LEAF}-${String(taskId)}`, cwdPicker: repoCwdPicker(repo.path) }
        ),
      ])
    ),
  ]);
  return withDisplay(subchain, { label: task.name, workItem: { kind: 'task', id: String(taskId) } });
};
