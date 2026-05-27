import type { Task } from '@src/domain/entity/task.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { Element } from '@src/application/chain/element.ts';
import { guard } from '@src/application/chain/build/guard.ts';
import { sequential } from '@src/application/chain/build/sequential.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import type { ImplementDeps } from '@src/application/flows/implement/deps.ts';
import { branchPreflightLeaf } from '@src/application/flows/implement/leaves/branch-preflight.ts';
import { buildTaskWorkspaceLeaf } from '@src/application/flows/implement/leaves/build-task-workspace.ts';
import { commitTaskLeaf } from '@src/application/flows/implement/leaves/commit-task.ts';
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
 * complete attempt lifecycle for ONE task: branch-preflight → workspace build → install-skills →
 * start-attempt → pre-task-verify → gen-eval loop → finalize → post-task-verify → commit
 * (guarded) → settle-attempt → progress-journal → uninstall-skills.
 *
 * The terminal `uninstall-skills` leaf name is the value of {@link IMPLEMENT_TASK_TERMINAL_LEAF}
 * exported from `flow.ts` and is what the TUI's task-completion detector keys on.
 *
 * Verify gate sits BEFORE commit so a red verifyScript blocks the task instead of landing
 * broken code on the sprint branch. On `verify-failed` the leaf stamps `lastBlockReason`,
 * the guard around `commit-task` skips, and `settle-attempt` marks the task `blocked`.
 *
 * Continue-on-blocked: tasks that settle `blocked` (self-block reason) do NOT halt the chain —
 * sibling tasks run unconditionally. The settle-attempt leaf catches the block, the chain
 * keeps going.
 */
export interface PerTaskSubchainOpts {
  readonly sprintDir: AbsolutePath;
  readonly progressFile: AbsolutePath;
  readonly terminalLeafName: string;
  readonly generator: GenEvalLoopRoleConfig;
  readonly evaluator: GenEvalLoopRoleConfig;
}

// `installSkillsLeaf` writes the bundled skill set to `<repo>/<parentDir>/skills/ralphctl-*/`.
// Pointing it at `repo.path` is what makes per-repo project skills, `.mcp.json`, and the
// provider-native context file (CLAUDE.md / .github/copilot-instructions.md / AGENTS.md)
// visible to the running AI — those are only auto-discovered from cwd, not from `--add-dir`
// roots. The `ralphctl-` prefix + the wildcard line the skills adapter appends to
// `.git/info/exclude` keeps the harness-authored copies out of the user's git tree.
const repoCwdPicker = (repoPath: AbsolutePath) => (): AbsolutePath => repoPath;

export const createPerTaskSubchain = (
  deps: ImplementDeps,
  opts: PerTaskSubchainOpts,
  task: Task,
  repo: RepoExecConfig,
  readConfig: () => Promise<{
    readonly maxTurns: number;
    readonly escalateOnPlateau: boolean;
    readonly escalationMap: Readonly<Record<string, string>>;
  }>
): Element<ImplementCtx> => {
  const taskId = task.id;
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
        ...(repo.verifyScript !== undefined ? { verifyScript: repo.verifyScript } : {}),
      },
      taskId
    ),
    installSkillsLeaf<ImplementCtx>(
      { skillsAdapter: deps.skillsAdapter, skillSource: deps.skillSource },
      { name: `install-skills-${String(taskId)}`, flowId: 'implement', cwdPicker: repoCwdPicker(repo.path) }
    ),
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
    // Append the per-attempt journal section to `<sprintDir>/progress.md`. Records the
    // verdict, attempt count, round info, duration, and the deduped decision count for the
    // just-settled attempt. Best-effort — the leaf logs and swallows failures.
    progressJournalLeaf(
      { appendFile: deps.appendFile, clock: deps.clock, logger: deps.logger },
      { progressFile: opts.progressFile, totalRounds: deps.config.harness.maxTurns },
      taskId
    ),
    uninstallSkillsLeaf<ImplementCtx>(
      { skillsAdapter: deps.skillsAdapter },
      { name: `${opts.terminalLeafName}-${String(taskId)}`, cwdPicker: repoCwdPicker(repo.path) }
    ),
  ]);
};
