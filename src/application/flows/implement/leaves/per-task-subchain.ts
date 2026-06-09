import type { Task } from '@src/domain/entity/task.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { Element } from '@src/application/chain/element.ts';
import { guard } from '@src/application/chain/build/guard.ts';
import { loop } from '@src/application/chain/build/loop.ts';
import { sequential } from '@src/application/chain/build/sequential.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import type { ImplementDeps } from '@src/application/flows/implement/deps.ts';
import { appendLearningsLeaf } from '@src/application/flows/implement/leaves/append-learnings.ts';
import { branchPreflightLeaf } from '@src/application/flows/implement/leaves/branch-preflight.ts';
import { buildTaskWorkspaceLeaf } from '@src/application/flows/implement/leaves/build-task-workspace.ts';
import { commitTaskLeaf } from '@src/application/flows/implement/leaves/commit-task.ts';
import { dependencyGateLeaf, isTaskRunnable } from '@src/application/flows/implement/leaves/dependency-gate.ts';
import { finalizeGenEvalLeaf } from '@src/application/flows/implement/leaves/finalize-gen-eval.ts';
import {
  createGenEvalLoop,
  type GenEvalLoopRoleConfig,
} from '@src/application/flows/implement/leaves/gen-eval-loop.ts';
import { postTaskVerifyLeaf } from '@src/application/flows/implement/leaves/post-task-verify.ts';
import { preTaskVerifyLeaf } from '@src/application/flows/implement/leaves/pre-task-verify.ts';
import { progressJournalLeaf } from '@src/application/flows/implement/leaves/progress-journal.ts';
import type { RepoExecConfig } from '@src/application/flows/implement/leaves/resolve-repo.ts';
import { settleAttemptLeaf } from '@src/application/flows/implement/leaves/settle-attempt.ts';
import { startAttemptLeaf } from '@src/application/flows/implement/leaves/start-attempt.ts';
import { installSkillsLeaf } from '@src/application/flows/_shared/skills/install-skills.ts';
import { uninstallSkillsLeaf } from '@src/application/flows/_shared/skills/uninstall-skills.ts';

/**
 * Per-task subchain factory. Returns the `sequential('task-<id>', [...])` element that runs the
 * complete lifecycle for ONE task.
 *
 * The shape is a dependency gate + a guarded body (once-per-task prologue + inner attempt loop +
 * once-per-task epilogue):
 *
 *   dependency-gate →                                                // block-upstream-if prereq ≠ done
 *   guard('task-runnable-<id>', sequential('task-body-<id>', [        // body runs only when runnable
 *     branch-preflight → workspace build → install-skills →          // once per task
 *     loop('task-attempts-<id>', sequential([                         // up to maxAttempts attempts
 *       start-attempt → pre-task-verify → gen-eval loop → finalize →
 *       post-task-verify → commit (guarded) → settle-attempt →
 *       append-learnings → progress-journal
 *     ]), { maxIterations: maxAttempts, shouldStop: terminal }) →
 *     uninstall-skills                                               // once per task
 *   ]))
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
 * the guard around `commit-task` skips, and `settle-attempt` marks the task `blocked`.
 *
 * Continue-on-blocked: tasks that settle `blocked` (self-block reason) do NOT halt the chain —
 * sibling tasks run unconditionally. The settle-attempt leaf catches the block, the chain
 * keeps going.
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
}

// `installSkillsLeaf` writes the bundled skill set to `<repo>/<parentDir>/skills/ralphctl-*/`.
// Pointing it at `repo.path` is what makes per-repo project skills, `.mcp.json`, and the
// provider-native context file (CLAUDE.md / .github/copilot-instructions.md / AGENTS.md)
// visible to the running AI — those are only auto-discovered from cwd, not from `--add-dir`
// roots. The `ralphctl-` prefix + the wildcard line the skills adapter appends to
// `.git/info/exclude` keeps the harness-authored copies out of the user's git tree.
const repoCwdPicker = (repoPath: AbsolutePath) => (): AbsolutePath => repoPath;

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
  readConfig: () => Promise<{
    readonly maxTurns: number;
    readonly escalateOnPlateau: boolean;
    readonly escalationMap: Readonly<Record<string, string>>;
    readonly maxAttempts: number;
  }>
): Element<ImplementCtx> => {
  const taskId = task.id;
  // The serial path keeps `branch-preflight` (default true) so a wrong-branch commit never lands;
  // the parallel launcher omits it (each task runs in its own dedicated worktree ref). Spliced via
  // a conditional spread so the serial element tree is byte-for-byte unchanged when included.
  const includeBranchPreflight = opts.includeBranchPreflight ?? true;
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
          { templateLoader: deps.templateLoader, logger: deps.logger },
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
        // Inner attempt loop. The body is the full per-attempt segment; the loop re-enters it
        // until `terminalTaskStatus` reports the settled task `done`/`blocked` or the `maxAttempts`
        // cap fires. `maxAttempts === 1` runs exactly once (single-attempt-per-launch parity); a
        // higher cap only manifests on the escalation-retry path. The 1000 ceiling on the `loop`
        // primitive is just a backstop — `maxAttempts` (validated 1–10) is the real bound here.
        loop<ImplementCtx>(
          `task-attempts-${String(taskId)}`,
          sequential<ImplementCtx>(`task-attempt-body-${String(taskId)}`, [
            startAttemptLeaf({ taskRepo: deps.taskRepo, clock: deps.clock, logger: deps.logger }, taskId),
            // PRE-task verify — captures the baseline state of the working tree BEFORE the AI runs
            // so the post-task-verify can attribute correctly: a red post on a green pre means the
            // AI regressed; a red post on a red pre is a pre-existing failure (don't blame the AI).
            // Non-blocking by policy — a red baseline just stamps `baselineBroken: true` on the
            // attempt and lets the AI try anyway.
            preTaskVerifyLeaf(
              {
                shellScriptRunner: deps.shellScriptRunner,
                taskRepo: deps.taskRepo,
                sprintExecutionRepo: deps.sprintExecutionRepo,
                interactive: deps.interactive,
                gitRunner: deps.gitRunner,
                clock: deps.clock,
                eventBus: deps.eventBus,
                logger: deps.logger,
              },
              {
                cwd: repo.path,
                sprintDir: opts.sprintDir,
                ...(repo.verifyScript !== undefined ? { verifyScript: repo.verifyScript } : {}),
                ...(repo.verifyTimeout !== undefined ? { timeoutMs: repo.verifyTimeout } : {}),
              },
              taskId
            ),
            // Composite: per-turn generator + evaluator, repeated until a terminal exit is set on ctx
            // or the configured `maxTurns` budget is hit. The evaluator is guarded — if the generator
            // self-blocked this turn it set `lastExit` and the evaluator must not run.
            createGenEvalLoop(
              {
                generatorProvider: deps.generatorProvider,
                evaluatorProvider: deps.evaluatorProvider,
                templateLoader: deps.templateLoader,
                signals: deps.signals,
                writeFile: deps.writeFile,
                clock: deps.clock,
                logger: deps.logger,
                eventBus: deps.eventBus,
                readConfig,
                maxTurns: deps.config.harness.maxTurns,
                plateauThreshold: deps.config.harness.plateauThreshold,
              },
              {
                cwd: repo.path,
                sprintDir: opts.sprintDir,
                progressFile: opts.progressFile,
                ...(repo.verifyScript !== undefined ? { verifyScript: repo.verifyScript } : {}),
                generator: opts.generator,
                evaluator: opts.evaluator,
              },
              taskId
            ),
            finalizeGenEvalLeaf(
              {
                taskRepo: deps.taskRepo,
                readConfig,
                logger: deps.logger,
                eventBus: deps.eventBus,
                clock: deps.clock,
                configuredGeneratorModel: opts.generator.model,
              },
              taskId
            ),
            // Verify gate sits BEFORE commit so a red verifyScript blocks the task instead of landing
            // broken code on the sprint branch. On `verify-failed` the leaf stamps `lastBlockReason`,
            // the guard around `commit-task` skips, and `settle-attempt` marks the task `blocked`.
            // The AI is told to run the verify script itself via the prompt; this leaf is the
            // harness-side enforcement.
            postTaskVerifyLeaf(
              {
                shellScriptRunner: deps.shellScriptRunner,
                taskRepo: deps.taskRepo,
                clock: deps.clock,
                eventBus: deps.eventBus,
                logger: deps.logger,
              },
              {
                cwd: repo.path,
                sprintDir: opts.sprintDir,
                ...(repo.verifyScript !== undefined ? { verifyScript: repo.verifyScript } : {}),
                ...(repo.verifyTimeout !== undefined ? { timeoutMs: repo.verifyTimeout } : {}),
              },
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
            // WRITE side of Theme 6 (audit-[B5]). Reads the STILL-POPULATED `currentAttemptLearnings`
            // accumulator and appends one NDJSON line per learning to the project's ledger. MUST run
            // BEFORE `progress-journal` — the journal clears that accumulator after it renders. Append
            // only (the read side dedups by stable id); best-effort (a failed append logs + proceeds).
            appendLearningsLeaf(
              { appendFile: deps.appendFile, clock: deps.clock, logger: deps.logger },
              { memoryRoot: opts.memoryRoot, projectId: opts.projectId, repoPath: repo.path, repoName: repo.name },
              taskId
            ),
            // Append the per-attempt journal section to `<sprintDir>/progress.md`. Records the
            // verdict, attempt count, round info, duration, and the deduped decision count for the
            // just-settled attempt. Best-effort — the leaf logs and swallows failures.
            progressJournalLeaf(
              { appendFile: deps.appendFile, clock: deps.clock, logger: deps.logger },
              { progressFile: opts.progressFile, totalRounds: deps.config.harness.maxTurns },
              taskId
            ),
          ]),
          {
            // The attempt count is bounded by the task's own `maxAttempts` (validated 1–10), or the
            // configured `settings.harness.maxAttempts` fallback for legacy tasks planned before the
            // field existed (mirrors the budget fallback in `finalize-gen-eval`/`decideEscalation`,
            // so a legacy task's loop cap and its escalation budget agree). The domain's
            // `failCurrentAttempt` still transitions the task to `blocked` once attempts hit the
            // cap, so a budget-exhausted task is never silently dropped — `shouldStop` just
            // recognises that terminal status and exits.
            maxIterations: task.maxAttempts ?? deps.config.harness.maxAttempts,
            shouldStop: (ctx) => terminalTaskStatus(ctx, taskId),
          }
        ),
        uninstallSkillsLeaf<ImplementCtx>(
          { skillsAdapter: deps.skillsAdapter },
          { name: `${opts.terminalLeafName}-${String(taskId)}`, cwdPicker: repoCwdPicker(repo.path) }
        ),
      ])
    ),
  ]);
};
