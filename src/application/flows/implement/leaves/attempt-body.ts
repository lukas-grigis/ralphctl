import type { AiProvider } from '@src/domain/entity/settings.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { IterationConfig } from '@src/application/chain/run/iteration-config.ts';
import type { Element } from '@src/application/chain/element.ts';
import { guard } from '@src/application/chain/build/guard.ts';
import { sequential } from '@src/application/chain/build/sequential.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import type { ImplementDeps } from '@src/application/flows/implement/deps.ts';
import { appendLearningsLeaf } from '@src/application/flows/implement/leaves/append-learnings.ts';
import {
  buildBestOfNGenEvalLoop,
  hasBestOfNCompositeRun,
  isBestOfNGranted,
} from '@src/application/flows/implement/leaves/best-of-n.ts';
import { toBestOfNGenEvalOpts } from '@src/application/flows/implement/leaves/best-of-n-candidate.ts';
import { commitTaskLeaf } from '@src/application/flows/implement/leaves/commit-task.ts';
import { finalizeGenEvalLeaf } from '@src/application/flows/implement/leaves/finalize-gen-eval.ts';
import {
  createGenEvalLoop,
  type GenEvalLoopRoleConfig,
} from '@src/application/flows/implement/leaves/gen-eval-loop.ts';
import type { PerTaskSubchainOpts } from '@src/application/flows/implement/leaves/per-task-subchain.ts';
import type { AgentDefinition } from '@src/integration/ai/agents/_engine/agent-definition.ts';
import { postTaskVerifyLeaf } from '@src/application/flows/implement/leaves/post-task-verify.ts';
import { preTaskVerifyLeaf } from '@src/application/flows/implement/leaves/pre-task-verify.ts';
import {
  isRedVerifyRetry,
  quarantineRetryDiffLeaf,
} from '@src/application/flows/implement/leaves/quarantine-retry-diff.ts';
import { progressJournalLeaf } from '@src/application/flows/implement/leaves/progress-journal.ts';
import { restoreBlockedDiffLeaf } from '@src/application/flows/implement/leaves/restore-blocked-diff.ts';
import type { RepoExecConfig } from '@src/application/flows/implement/leaves/resolve-repo.ts';
import { settleAttemptLeaf } from '@src/application/flows/implement/leaves/settle-attempt.ts';
import { startAttemptLeaf } from '@src/application/flows/implement/leaves/start-attempt.ts';

/**
 * Per-spawn harness config re-read on every attempt / turn so a mid-run settings edit reaches the
 * budgets and the escalation policy without relaunching.
 */
export type AttemptReadConfig = () => Promise<{
  readonly maxTurns: number;
  readonly escalateOnPlateau: boolean;
  readonly escalationMap: Readonly<Record<string, string>>;
  readonly maxAttempts: number;
  /**
   * Opt-in best-of-N candidate count for the escalation policy's top-of-ladder remedy — mirrors
   * `settings.harness.bestOfNCandidates`. OPTIONAL: absent/`0` disables the remedy (the default),
   * and every existing `readConfig` implementation across the codebase (which predates this field)
   * keeps compiling unchanged.
   */
  readonly bestOfNCandidates?: number | undefined;
}>;

/**
 * Build an {@link AttemptReadConfig} from a live `IterationConfig` slice — the ONE place that
 * projects `deps.config.harness` down to the fields the attempt loop / escalation policy read.
 * Both the serial launcher (`flow.ts`) and the parallel launcher (`ui/shared/launch/implement.ts`)
 * call this rather than each re-listing the same five fields: a field added to
 * `AttemptReadConfig`'s return shape (like `bestOfNCandidates`) used to require updating BOTH
 * call sites by hand, and the parallel one was missed for a full wave — the opt-in best-of-N
 * remedy silently never fired on a parallel-launched sprint. One shared builder makes that class
 * of drift impossible: a new field is threaded here once and both launchers pick it up for free.
 *
 * @public
 */
export const buildAttemptReadConfig = (harness: IterationConfig): AttemptReadConfig => {
  const snapshot = {
    maxTurns: harness.maxTurns,
    escalateOnPlateau: harness.escalateOnPlateau,
    escalationMap: harness.escalationMap,
    maxAttempts: harness.maxAttempts,
    ...(harness.bestOfNCandidates !== undefined ? { bestOfNCandidates: harness.bestOfNCandidates } : {}),
  };
  return () => Promise.resolve(snapshot);
};

/**
 * Fold a role's already-resolved bound agent-definition NAME onto its `GenEvalLoopRoleConfig` —
 * the same `AgentDefinition` {@link buildAgentDefinitionInstallLeaves} installs, read again here
 * so the FULL prompt's `{{PROJECT_TOOLING}}` catalog can name the same binding
 * `agentDefinitionSection` already announces in prose. A no-op (returns `role` unchanged) when
 * the role has no binding. Split out of `createPerTaskSubchain` so this call site's extra branch
 * doesn't grow that function's own complexity budget.
 */
const withAgentDefinitionName = (
  role: GenEvalLoopRoleConfig,
  definition: AgentDefinition | undefined
): GenEvalLoopRoleConfig => (definition !== undefined ? { ...role, agentDefinitionName: definition.name } : role);

/**
 * Build the normal (non-best-of-N) `createGenEvalLoop` element — reused by BOTH the knob-off
 * single-element path and the knob-on "normal branch" guard below, so the two paths cannot drift
 * apart from each other.
 */
const buildNormalGenEvalElement = (
  deps: ImplementDeps,
  opts: PerTaskSubchainOpts,
  repo: RepoExecConfig,
  taskId: TaskId,
  readConfig: AttemptReadConfig
): Element<ImplementCtx> =>
  createGenEvalLoop(
    {
      generatorProvider: deps.generatorProvider,
      evaluatorProvider: deps.evaluatorProvider,
      templateLoader: deps.templateLoader,
      publishSignal: deps.publishSignal,
      writeFile: deps.writeFile,
      // Threaded so the FULL prompt's `{{PROJECT_TOOLING}}` catalog can name this
      // task's installed skills — the same source `installSkillsLeaf` above reads.
      skillSource: deps.skillSource,
      gitRunner: deps.gitRunner,
      clock: deps.clock,
      logger: deps.logger,
      eventBus: deps.eventBus,
      readConfig,
      maxTurns: deps.config.harness.maxTurns,
      plateauThreshold: deps.config.harness.plateauThreshold,
      correctiveRetries: deps.config.harness.correctiveRetries,
      // Opt-in action-entropy detector (default off) — a static launch-time knob, same channel as
      // `skipPreVerifyOnFreshSetup` below.
      entropyPlateauDetector: deps.config.harness.entropyPlateauDetector,
    },
    {
      cwd: repo.path,
      sprintDir: opts.sprintDir,
      progressFile: opts.progressFile,
      ...(repo.verifyScript !== undefined ? { verifyScript: repo.verifyScript } : {}),
      // Fold in each role's bound agent-definition NAME (already resolved for the
      // install/uninstall leaves above) so `{{PROJECT_TOOLING}}` names the same
      // binding `{{AGENT_DEFINITION_SECTION}}` already announces in prose.
      generator: withAgentDefinitionName(opts.generator, opts.generatorAgentDefinition),
      evaluator: withAgentDefinitionName(opts.evaluator, opts.evaluatorAgentDefinition),
    },
    taskId
  );

/**
 * Build the attempt's gen-eval segment — the composite that runs the per-turn generator +
 * evaluator until a terminal exit lands on ctx or `maxTurns` is hit.
 *
 * `settings.harness.bestOfNCandidates` is read STATICALLY here (construction time, like
 * `maxTurns` / `plateauThreshold` / `correctiveRetries`) rather than via `readConfig`: off
 * (0/undefined, the default) returns exactly ONE element — {@link buildNormalGenEvalElement},
 * byte-for-byte the pre-best-of-n shape, so a non-opted-in operator's attempts are unaffected
 * down to the trace. On, it returns a guarded PAIR, each behind a `guard` that reads the
 * PER-ATTEMPT runtime grant ({@link isBestOfNGranted}) — the once-per-task stamp means at most
 * ONE attempt of a task ever takes the best-of-N branch; every other attempt (before and after
 * it) takes the normal branch unchanged. See `best-of-n.ts`'s module docstring for the full
 * replace-round-1's-generator-phase design.
 */
const buildGenEvalSegment = (
  deps: ImplementDeps,
  opts: PerTaskSubchainOpts,
  repo: RepoExecConfig,
  taskId: TaskId,
  readConfig: AttemptReadConfig
): Array<Element<ImplementCtx>> => {
  const normalElement = buildNormalGenEvalElement(deps, opts, repo, taskId, readConfig);
  const n = deps.config.harness.bestOfNCandidates;
  if (n === undefined || n < 2) return [normalElement];

  const bestOfNElement = buildBestOfNGenEvalLoop(
    deps,
    toBestOfNGenEvalOpts(
      repo,
      opts.sprintDir,
      opts.progressFile,
      withAgentDefinitionName(opts.generator, opts.generatorAgentDefinition),
      withAgentDefinitionName(opts.evaluator, opts.evaluatorAgentDefinition)
    ),
    taskId,
    async () => ({ maxTurns: (await readConfig()).maxTurns })
  );
  return [
    guard<ImplementCtx>(`best-of-n-branch-${String(taskId)}`, isBestOfNGranted, bestOfNElement),
    // Deliberately NOT `!isBestOfNGranted` — that predicate is derived from the mutable
    // `task.bestOfNGrantedCandidates` field, which `bestOfNElement`'s own selection leaf clears
    // partway through ITS OWN execution (so a LATER attempt of the task doesn't re-trigger the
    // grant). Since this second guard is only evaluated AFTER `bestOfNElement` has fully returned,
    // re-deriving "not granted" from that same field would read the just-cleared state and run
    // the normal loop TOO, doubling the attempt's turn budget. `hasBestOfNCompositeRun` reads a
    // separate, composite-scoped ctx counter that stays defined for the rest of the attempt
    // regardless of what the selection leaf clears — see `best-of-n.ts`'s docstring.
    guard<ImplementCtx>(
      `normal-gen-eval-branch-${String(taskId)}`,
      (ctx) => !hasBestOfNCompositeRun(ctx),
      normalElement
    ),
  ];
};

/**
 * The productive half of one attempt: open the attempt, restore any quarantined diff so a retry
 * continues from the prior AI work, capture the pre-verify baseline, run the gen-eval loop, and
 * finalize its exit into an escalation / retry decision.
 */
const attemptWorkLeaves = (
  deps: ImplementDeps,
  opts: PerTaskSubchainOpts,
  taskId: TaskId,
  repo: RepoExecConfig,
  readConfig: AttemptReadConfig
): Array<Element<ImplementCtx>> => [
  startAttemptLeaf({ taskRepo: deps.taskRepo, clock: deps.clock, logger: deps.logger }, taskId),
  // Restore a prior blocked diff (if any) at the START of each attempt so an escalation /
  // retry continues from the prior AI work plus the evaluator critique instead of from a
  // clean tree. A no-op when no matching stash exists (the common case); the quarantine
  // stash is keyed on (sprintId, taskId) and shared across git worktrees, so this is safe
  // on BOTH the serial and parallel paths — no conditional spread.
  restoreBlockedDiffLeaf({ gitRunner: deps.gitRunner, logger: deps.logger }, { cwd: repo.path }, taskId),
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
      // Opt-in fresh-setup skip — read straight off the harness config (a static
      // launch-time value, same channel as `effectiveMaxAttempts` below; not a mid-run
      // re-readable knob, so it rides `deps.config` rather than `readConfig`).
      skipPreVerifyOnFreshSetup: deps.config.harness.skipPreVerifyOnFreshSetup,
      ...(repo.verifyScript !== undefined ? { verifyScript: repo.verifyScript } : {}),
      ...(repo.verifyGates !== undefined ? { verifyGates: repo.verifyGates } : {}),
      ...(repo.verifyTimeout !== undefined ? { timeoutMs: repo.verifyTimeout } : {}),
    },
    taskId
  ),
  // Composite: per-turn generator + evaluator, repeated until a terminal exit is set on ctx
  // or the configured `maxTurns` budget is hit. The evaluator is guarded — if the generator
  // self-blocked this turn it set `lastExit` and the evaluator must not run. See
  // `buildGenEvalSegment`'s docstring for the best-of-N knob-gating rationale.
  ...buildGenEvalSegment(deps, opts, repo, taskId, readConfig),
  finalizeGenEvalLeaf(
    {
      taskRepo: deps.taskRepo,
      readConfig,
      logger: deps.logger,
      eventBus: deps.eventBus,
      clock: deps.clock,
      configuredGeneratorModel: opts.generator.model,
      // Activate the escalation policy's same-model effort rung: forward the generator
      // provider + its launch-resolved effort so a top-of-ladder plateau bumps reasoning
      // effort to the next provider-aware tier (Claude: up to max; Copilot/Codex: high)
      // before spending the nudge. `providerId` is the resolved provider enum string;
      // `nextEffortRung` skips gracefully for any non-effort provider or model.
      configuredGeneratorProvider: opts.generator.providerId as AiProvider,
      ...(opts.generator.effort !== undefined ? { configuredGeneratorEffort: opts.generator.effort } : {}),
      // Same lockstep wiring for the EVALUATOR role: the policy computes its bump
      // independently against this triple, never copying the generator's target. The
      // evaluator MODEL is never escalated, but it still rides through so `nextEffortRung`
      // can classify the evaluator's own effort ladder.
      configuredEvaluatorProvider: opts.evaluator.providerId as AiProvider,
      configuredEvaluatorModel: opts.evaluator.model,
      ...(opts.evaluator.effort !== undefined ? { configuredEvaluatorEffort: opts.evaluator.effort } : {}),
    },
    taskId
  ),
];

/**
 * The settling half of one attempt: gate the work on a green verify, commit it, quarantine a
 * rejected diff, settle the attempt, then persist what it learned.
 */
const attemptSettleLeaves = (
  deps: ImplementDeps,
  opts: PerTaskSubchainOpts,
  taskId: TaskId,
  repo: RepoExecConfig,
  effectiveMaxAttempts: number
): Array<Element<ImplementCtx>> => [
  // Verify gate sits BEFORE commit so a red verifyScript blocks the task instead of landing
  // broken code on the sprint branch. On `verify-failed` the leaf stamps `lastBlockReason`,
  // the guard around `commit-task` skips, and `settle-attempt` marks the task `blocked`.
  // The AI is told to run the verify script itself via the prompt; this leaf is the
  // harness-side enforcement.
  postTaskVerifyLeaf(
    {
      shellScriptRunner: deps.shellScriptRunner,
      taskRepo: deps.taskRepo,
      // Diff-footprint probe for structured-gate scoping (T11). Shared serial-path runner.
      gitRunner: deps.gitRunner,
      clock: deps.clock,
      eventBus: deps.eventBus,
      logger: deps.logger,
    },
    {
      cwd: repo.path,
      sprintDir: opts.sprintDir,
      // T6: the effective attempt cap so a `'regressed'` post-verify retries within budget
      // (settle precedence keeps the task in_progress) instead of blocking immediately.
      // SAME value as the loop's `maxIterations` below — shared const, never drifts.
      maxAttempts: effectiveMaxAttempts,
      ...(repo.verifyScript !== undefined ? { verifyScript: repo.verifyScript } : {}),
      ...(repo.verifyGates !== undefined ? { verifyGates: repo.verifyGates } : {}),
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
        logger: deps.logger,
      },
      { cwd: repo.path },
      taskId
    )
  ),
  // Composed-case cleanup: a granted retry (escalate / nudge / malformed) whose work ALSO
  // failed post-verify red. The commit guard above skipped the red work; this stashes it
  // so the RETRIED attempt's pre-verify starts from the last good commit instead of
  // hard-blocking on its own predecessor's rejected diff. Must run BEFORE settle-attempt —
  // settle's output projection clears both flags the guard reads. Green-verify retries
  // commit normally and the stash no-ops on their clean tree.
  guard<ImplementCtx>(
    `quarantine-retry-diff-guard-${String(taskId)}`,
    isRedVerifyRetry,
    quarantineRetryDiffLeaf({ gitRunner: deps.gitRunner, logger: deps.logger }, { cwd: repo.path }, taskId)
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
    { appendFile: deps.appendFile, writeFile: deps.writeFile, clock: deps.clock, logger: deps.logger },
    {
      memoryRoot: opts.memoryRoot,
      projectId: opts.projectId,
      projectSlug: opts.projectSlug,
      repoPath: repo.path,
      repoName: repo.name,
    },
    taskId
  ),
  // Write the per-attempt journal section to `<sprintDir>/progress.md` and regenerate the
  // derived state header band in place. Records the verdict, attempt count, round info,
  // duration, and the deduped signals for the just-settled attempt. Fail-loud / self-healing:
  // a failed section write retries once, then writes a visible gap marker + logs at error level.
  progressJournalLeaf(
    {
      writeFile: deps.writeFile,
      clock: deps.clock,
      logger: deps.logger,
      journalMutex: deps.journalMutex,
    },
    { progressFile: opts.progressFile, totalRounds: deps.config.harness.maxTurns },
    taskId
  ),
];

/**
 * One attempt of a task, as the `sequential('task-attempt-body-<id>', [...])` the surrounding
 * attempt loop re-enters until the task settles terminal or the attempt cap fires:
 *
 *   start-attempt → restore-blocked-diff → pre-task-verify → gen-eval loop → finalize →
 *   post-task-verify → commit (guarded) → quarantine-retry-diff (guarded) → settle-attempt →
 *   append-learnings → progress-journal
 *
 * Two orderings inside are load-bearing and called out where they sit: the verify gate runs
 * BEFORE commit so a red verify script can never land broken code, and the retry quarantine runs
 * BEFORE settle-attempt because settle's output projection clears both flags its guard reads.
 */
export const buildAttemptBody = (
  deps: ImplementDeps,
  opts: PerTaskSubchainOpts,
  task: Task,
  repo: RepoExecConfig,
  readConfig: AttemptReadConfig,
  /**
   * Effective per-task attempt cap, computed once by the caller so the loop's `maxIterations` and
   * `post-task-verify`'s red-post-verify retry budget read the same value and can never disagree
   * about which attempt the budget runs out on.
   */
  effectiveMaxAttempts: number
): Element<ImplementCtx> =>
  sequential<ImplementCtx>(`task-attempt-body-${String(task.id)}`, [
    ...attemptWorkLeaves(deps, opts, task.id, repo, readConfig),
    ...attemptSettleLeaves(deps, opts, task.id, repo, effectiveMaxAttempts),
  ]);
