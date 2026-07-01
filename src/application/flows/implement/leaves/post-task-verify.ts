import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { Attribution, VerifyRun, VerifyRunOutcome } from '@src/domain/entity/attempt.ts';
import { attributeVerify, normalizeVerifyGates, runVerifyGatesUseCase } from '@src/business/task/run-verify-script.ts';
import type { RunVerifyScriptOutput } from '@src/business/task/run-verify-script.ts';
import type { VerifyGate } from '@src/domain/entity/repository.ts';
import { gitDiffFootprint } from '@src/integration/io/git-operations.ts';
import type { GitRunner } from '@src/integration/io/git-runner.ts';
import { writeTextAtomic } from '@src/integration/io/fs.ts';
import { appendAttemptVerifyRun, setAttemptAttribution } from '@src/domain/entity/task-attempts.ts';
import type { InProgressTask, Task } from '@src/domain/entity/task.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { UpdateTask } from '@src/domain/repository/task/update-task.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import type { ShellScriptRunner } from '@src/integration/io/shell-script-runner.ts';
import { runVerifyShell } from '@src/application/flows/implement/leaves/pre-task-verify.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';

/** `VerifyRunOutcome` member tag for a shell that could not start the command. */
const SPAWN_ERROR_OUTCOME = 'spawn-error';

/**
 * Post-task verify gate — the harness's AUTHORITATIVE independent verification. Runs the
 * project's `verifyScript` after the AI commits its work, regardless of any `task-verified`
 * signal the AI may have emitted. Belt-and-braces: the AI's self-report is advisory; this
 * leaf's outcome is what drives the task transition.
 *
 * Captures a `phase: 'post'` {@link VerifyRun} row on the running attempt and pairs it with
 * the `phase: 'pre'` row from `pre-task-verify` to compute {@link Attribution}:
 *
 *  - pre=success, post=success → `'clean'`           — accept the AI's verdict as-is.
 *  - pre=success, post=failed  → `'regressed'`       — the AI broke a green baseline; block.
 *  - pre=failed,  post=success → `'fixed-baseline'`  — the AI repaired a failure; credit it.
 *  - pre=failed,  post=failed  → `'baseline-broken'` — pre-existing failure; don't blame AI.
 *  - pre=spawn-error           → attribution skipped — unknown baseline state.
 *
 * Ctx side effects mirror the original leaf so `settle-attempt` and `commit-task` continue
 * to read the same fields:
 *
 *   - `lastVerifyResult` — `'skipped' | 'passed' | 'verify-failed'`, derived from the row.
 *   - `lastBlockReason`  — set on raw red post and on `'regressed'`. Pre-existing failures
 *                          (`baseline-broken`) do NOT block — they preserve the AI's verdict so
 *                          the operator can fix the baseline without losing the AI's work.
 *   - `lastShouldFailAttempt` — set to `true` ON `'regressed'` AND ONLY WHILE the task's attempt
 *                          budget remains (see {@link budgetRemains}). This is the bounded
 *                          red-post-verify RETRY (T6): an evaluator-passed attempt whose harness
 *                          post-verify regressed a green baseline gets one more attempt — the same
 *                          retry seam an escalation grant uses — instead of blocking immediately.
 *
 * ## Why the retry outranks the block (mirrors `settle-attempt`'s PRECEDENCE rule)
 *
 * On a `'regressed'` attempt with budget remaining this leaf sets BOTH `lastShouldFailAttempt`
 * AND `lastBlockReason`. They co-occur deliberately, and `settle-attempt`'s precedence resolves
 * the composition in the retry's favour: a granted retry outranks a block reason, because the
 * whole point of the attempt budget is to spend remedies before surrendering, and a red verify on
 * the failing work is exactly the signal a fresh attempt targets. The red work NEVER lands: the
 * `commit-task` guard keys on `lastBlockReason` INDEPENDENTLY of the retry flag (so the broken
 * diff is never committed), and `quarantineRetryDiffLeaf` (guarded on both flags via
 * `isRedVerifyRetry`) stashes the rejected diff so the retried attempt's pre-verify starts clean.
 * The next loop iteration re-enters `start-attempt` with a fresh attempt whose generator prompt now
 * carries the `<retry_feedback>` block (the prior attempt's failing post-verify output). Once the
 * budget exhausts this leaf stops setting the retry flag and the same red verify blocks the task —
 * a human then intervenes (today's behaviour, now reserved for genuine budget exhaustion).
 *
 * Other attributions keep today's behaviour exactly: `clean` / `fixed-baseline` (post green → no
 * block), `baseline-broken` (escape hatch → no block, preserve verdict), and `undefined` (raw red
 * with no pre-verify evidence → block, no retry).
 *
 * This leaf must sit BEFORE `commit-task` in the per-task chain — that's how the harness
 * enforces "tests must pass before we declare the task complete." The AI is told to run the
 * verify script itself via the prompt, but the harness is the source of truth.
 */

export interface PostTaskVerifyLeafDeps {
  readonly shellScriptRunner: ShellScriptRunner;
  readonly taskRepo: UpdateTask;
  /**
   * Used to compute the attempt's diff footprint (`git diff --name-only HEAD` + untracked) so the
   * structured verify gates run only for the modules the diff touched. A footprint failure or an
   * empty result falls back to running ALL gates — never silently skips. Only consulted when
   * `opts.verifyGates` is present AND non-empty; the legacy single-script path ignores it.
   */
  readonly gitRunner: GitRunner;
  readonly clock: () => IsoTimestamp;
  readonly eventBus: EventBus;
  readonly logger: Logger;
}

export interface PostTaskVerifyLeafOpts {
  readonly cwd: AbsolutePath;
  readonly verifyScript?: string;
  /**
   * Structured per-module verify gates (WS3). When present AND non-empty, the leaf runs THESE via
   * the multi-gate executor in `fail-fast` mode, SCOPED to the attempt's diff footprint (only
   * gates whose `pathPrefix` matches a changed path). Footprint failure / empty → run ALL gates.
   * Absent → the leaf normalises `verifyScript` to a single catch-all gate (one code path). The
   * `'regressed'` attribution semantics are unchanged: a scoped red post on a green pre is still
   * `regressed`, because every post-executed gate also ran in pre's full set.
   */
  readonly verifyGates?: readonly VerifyGate[];
  readonly timeoutMs?: number;
  /**
   * Per-sprint state directory. When set, the leaf writes the full untruncated verify-script
   * output to `<sprintDir>/logs/verify/<task-id>/post-attempt-<N>.log` per audit [01] / [03].
   */
  readonly sprintDir?: AbsolutePath;
  /**
   * Effective per-task attempt cap (T6). Resolved at wiring time in `per-task-subchain.ts` as
   * `task.maxAttempts ?? settings.harness.maxAttempts` — the SAME expression the outer attempt
   * loop uses for its `maxIterations`, so the leaf's retry budget and the loop's iteration cap can
   * never disagree. A `'regressed'` post-verify grants the bounded retry only while budget remains
   * (see {@link budgetRemains}); on the last allowed attempt it blocks instead. Undefined for
   * legacy callers without a cap wired — those keep the pre-T6 block-immediately behaviour because
   * {@link budgetRemains} returns `false` when the cap is unknown.
   */
  readonly maxAttempts?: number;
}

interface LeafInput {
  readonly task: InProgressTask;
  readonly sprintId: SprintId;
  readonly preOutcome?: VerifyRunOutcome;
  /**
   * True when the task was blocked BEFORE any gen-eval turn ran — i.e. pre-task-verify
   * hard-blocked (non-interactive red baseline / operator skip) and the loop's `shouldContinue`
   * refused entry, so the generator never spawned. Drives the zero-turn short-circuit below:
   * with no AI work to verify, re-running the dominant-cost verify script is pure waste and
   * there is nothing to attribute (HARNESS-PRINCIPLES § 9). Derived in `input` from
   * `ctx.lastBlockReason` set AND `ctx.genEvalTurn === undefined` — start-attempt resets
   * `genEvalTurn` per attempt, the generator leaf bumps it to ≥1 on its first turn, so an unset
   * counter is precisely "zero turns ran." A turn-1 generator self-block has `genEvalTurn === 1`
   * and correctly falls through to the real script.
   */
  readonly preVerifyBlockedZeroTurn: boolean;
}

interface LeafOutput {
  readonly task: InProgressTask;
  readonly run: VerifyRun;
  readonly attribution?: Attribution;
  /**
   * Carried into the leaf's `output` projection so {@link legacyVerifyResult} can derive
   * `lastVerifyResult.stderr` from the spawn output rather than from a persisted tail-bytes
   * field on the audit row. Wave 8 dropped the latter (audit-[06]); the full untruncated
   * body now lives in `<sprintDir>/logs/verify/...`.
   */
  readonly rawOutput: string;
  readonly spawnErrorMessage?: string;
}

/**
 * Project the structured {@link VerifyRun} into the legacy `lastVerifyResult` ctx shape
 * (`'skipped' | 'passed' | 'verify-failed'`) so `settle-attempt` keeps deriving its existing
 * `verify-failed` {@link AttemptWarning} without rewiring. `spawn-error` is folded into
 * `'verify-failed'` (exitCode = -1) — same legacy behaviour as the prior implementation.
 *
 * `stderr` carries the full untruncated spawn output (or the shell's spawn-error message)
 * verbatim per audit-[03]: truncation happens at the display boundary (sprint-detail-view
 * already clips to the first non-blank line + 120 chars when surfacing the warning), never
 * at write time. The on-disk source of truth is `<sprintDir>/logs/verify/<task-id>/...`
 * (audit-[01]); the ctx field is for the in-process settle handoff.
 */
const legacyVerifyResult = (
  run: VerifyRun,
  rawOutput: string,
  spawnErrorMessage?: string
): NonNullable<ImplementCtx['lastVerifyResult']> => {
  if (run.outcome === 'skipped') return { kind: 'skipped' };
  if (run.outcome === 'success') return { kind: 'passed' };
  const stderr = run.outcome === SPAWN_ERROR_OUTCOME ? (spawnErrorMessage ?? '') : rawOutput;
  return { kind: 'verify-failed', exitCode: run.exitCode, stderr };
};

/**
 * Whether a `'regressed'` post-verify may grant the bounded red-post-verify RETRY (T6) rather than
 * block. Budget is counted by attempts INCLUDING the running one: `start-attempt` appended the
 * running attempt before this leaf, so `attempts.length` already counts it as spent. The retry is
 * granted while `attempts.length < maxAttempts` — i.e. a fresh attempt slot remains under the cap.
 *
 * Worked example (the explicit case the spec pins): with `maxAttempts === 3` and the running
 * attempt being the 3rd (`attempts.length === 3`), `3 < 3` is `false` → NO retry, the task blocks.
 * On the 1st of 3 (`attempts.length === 1`), `1 < 3` is `true` → retry. The comparison matches the
 * domain's own cap check in `failCurrentAttempt` (`attempts.length >= maxAttempts → blocked`), so
 * the leaf and the loop agree on the exact attempt the budget runs out.
 *
 * `cap === undefined` (no budget wired) returns `false` — legacy callers keep blocking immediately,
 * the pre-T6 behaviour.
 */
const budgetRemains = (task: InProgressTask, cap: number | undefined): boolean =>
  cap !== undefined && task.attempts.length < cap;

/**
 * Compute the diff-footprint scope for the structured verify gates, or `undefined` to signal the
 * run-ALL-gates fallback. Returns `undefined` (NOT an empty array) when:
 *
 *  - the footprint probe errored (corrupt repo / git missing) — we cannot trust a partial scope;
 *  - the footprint is empty (the AI committed everything already, so `git diff HEAD` shows nothing,
 *    or it made no changes) — a scoped run would then skip EVERY non-catch-all gate, defeating the
 *    point of an authoritative post-verify.
 *
 * In both cases the caller passes no scope, so the executor runs all gates. The fallback is logged
 * (warn for an error, debug for an empty footprint) — the gate is never silently skipped.
 */
const computeScope = async (
  deps: Pick<PostTaskVerifyLeafDeps, 'gitRunner' | 'eventBus' | 'clock'>,
  cwd: AbsolutePath
): Promise<readonly string[] | undefined> => {
  const footprint = await gitDiffFootprint(deps.gitRunner, cwd);
  if (!footprint.ok) {
    deps.eventBus.publish({
      type: 'log',
      level: 'warn',
      message: `post-task-verify ${String(cwd)}: diff footprint failed (${footprint.error.message}) — running ALL verify gates`,
      at: deps.clock(),
    });
    return undefined;
  }
  if (footprint.value.length === 0) {
    deps.eventBus.publish({
      type: 'log',
      level: 'debug',
      message: `post-task-verify ${String(cwd)}: empty diff footprint — running ALL verify gates`,
      at: deps.clock(),
    });
    return undefined;
  }
  return footprint.value;
};

/**
 * Zero-turn short-circuit result. When pre-task-verify hard-blocked the task BEFORE any
 * generator spawned (the gen-eval loop's `shouldContinue` refused entry on a pre-existing
 * `lastExit`), there is no AI work on the tree to verify — re-running the dominant-cost verify
 * script is pure waste, and there is nothing to attribute (HARNESS-PRINCIPLES § 9). Synthesises a
 * `'skipped'` VerifyRun so the ctx carry stays consistent: `legacyVerifyResult` maps `'skipped'`
 * to `{ kind: 'skipped' }` (no spurious verify-failed warning downstream), attribution stays
 * undefined (it needs both pre and post outcomes), and `priorPostVerifyOutcome` carries
 * `'skipped'` so the NEXT task's pre-verify carry-baseline does not short-circuit (that path
 * requires `'success'`).
 */
const buildZeroTurnSkippedResult = (deps: Pick<PostTaskVerifyLeafDeps, 'clock'>, task: InProgressTask): LeafOutput => {
  const skipped: VerifyRun = {
    phase: 'post',
    ranAt: deps.clock(),
    command: '',
    exitCode: 0,
    durationMs: 0,
    outcome: 'skipped',
  };
  return { task, run: skipped, rawOutput: '' };
};

/**
 * Normalise legacy script + structured gates into ONE gate list (gates win when present), then
 * run it via {@link runVerifyGatesUseCase}. Diff-scopes the gates to the attempt's footprint —
 * but ONLY when the repo actually configured structured gates. The legacy single catch-all gate
 * matches every path, so computing a footprint for it is wasted git work; leave `scope` undefined
 * (all-run subset = the one gate). When gates ARE configured we compute the footprint and pass it
 * as scope; fail-fast stops at the first red scoped gate. CRITICAL fallback: a footprint failure
 * or an empty result runs ALL gates (scope undefined) — we never silently skip a gate.
 */
const runPostVerifyGates = async (
  deps: PostTaskVerifyLeafDeps,
  opts: PostTaskVerifyLeafOpts,
  signal?: AbortSignal
): Promise<RunVerifyScriptOutput> => {
  const gates = normalizeVerifyGates(opts.verifyScript, opts.verifyGates);
  const usingStructuredGates = opts.verifyGates !== undefined && opts.verifyGates.length > 0;
  const scope = usingStructuredGates ? await computeScope(deps, opts.cwd) : undefined;
  return runVerifyGatesUseCase({
    cwd: opts.cwd,
    phase: 'post',
    gates,
    mode: 'fail-fast',
    ...(scope !== undefined ? { scope } : {}),
    ...(opts.timeoutMs !== undefined ? { defaultTimeoutMs: opts.timeoutMs } : {}),
    clock: deps.clock,
    // Thread the chain abort signal so a Ctrl-C mid-verify kills the child promptly instead
    // of stranding the repo lock for the full verifyTimeout. `runVerifyShell` collapses the
    // runner's widened `AbortError` to a `StorageError` shape for the use-case port — the
    // real cancellation is surfaced verbatim by the `signal.aborted` check in the caller.
    runShellScript: (cwd, script, scriptOpts) =>
      runVerifyShell(deps.shellScriptRunner, cwd, script, {
        ...scriptOpts,
        ...(signal !== undefined ? { signal } : {}),
      }),
    logger: deps.logger,
  });
};

/**
 * Audit [01] / [03]: persist the full untruncated output to
 * `<sprintDir>/logs/verify/<task-id>/post-attempt-<N>.log`. Caller only invokes this when
 * `opts.sprintDir` is set AND `rawOutput` is non-empty.
 */
const persistPostVerifyLog = async (
  deps: PostTaskVerifyLeafDeps,
  opts: PostTaskVerifyLeafOpts,
  task: InProgressTask,
  rawOutput: string
): Promise<void> => {
  const attemptN = task.attempts.length;
  const logPath = join(
    String(opts.sprintDir),
    'logs',
    'verify',
    String(task.id),
    `post-attempt-${String(attemptN)}.log`
  );
  const wrote = await writeTextAtomic(logPath, rawOutput);
  if (!wrote.ok) {
    deps.eventBus.publish({
      type: 'log',
      level: 'warn',
      message: `post-task-verify ${String(opts.cwd)}: failed to persist full log to ${logPath} — ${wrote.error.message}`,
      at: deps.clock(),
    });
  }
};

/**
 * Append the {@link VerifyRun} row to the attempt, stamp {@link Attribution} when both pre and
 * post outcomes are known (`attributeVerify` returns undefined for a spawn-error/skipped pre —
 * the field stays unset), and persist the updated task. A persist failure is logged but does not
 * fail the leaf — the audit row already lives on the in-memory task carried forward on ctx.
 */
const recordVerifyRun = async (
  deps: PostTaskVerifyLeafDeps,
  input: LeafInput,
  run: VerifyRun,
  taskId: TaskId
): Promise<Result<{ readonly task: InProgressTask; readonly attribution?: Attribution }, DomainError>> => {
  let updated = appendAttemptVerifyRun(input.task, run);
  if (!updated.ok) return Result.error(updated.error);

  const attribution = input.preOutcome !== undefined ? attributeVerify(input.preOutcome, run.outcome) : undefined;
  if (attribution !== undefined) {
    const stamped = setAttemptAttribution(updated.value, attribution);
    if (!stamped.ok) return Result.error(stamped.error);
    updated = stamped;
  }

  const persisted = await deps.taskRepo.update(input.sprintId, updated.value);
  if (!persisted.ok) {
    deps.eventBus.publish({
      type: 'log',
      level: 'warn',
      message: `post-task-verify audit persist failed for task ${String(taskId)} — ${persisted.error.message}`,
      at: deps.clock(),
    });
  }

  return Result.ok({ task: updated.value, ...(attribution !== undefined ? { attribution } : {}) });
};

/**
 * Emit the outcome-specific log line for the attribution decision (or a raw spawn-error).
 * Logging only — the block/retry policy itself lives in {@link projectLeafOutput}.
 */
const logAttributionOutcome = (
  deps: PostTaskVerifyLeafDeps,
  opts: PostTaskVerifyLeafOpts,
  run: VerifyRun,
  attribution: Attribution | undefined,
  spawnErrorMessage: string | undefined
): void => {
  if (attribution === 'regressed') {
    deps.eventBus.publish({
      type: 'log',
      level: 'error',
      message: `post-task-verify ${String(opts.cwd)}: regressed baseline (exit=${String(run.exitCode)}) — blocking task`,
      at: deps.clock(),
    });
  } else if (attribution === 'baseline-broken') {
    deps.eventBus.publish({
      type: 'log',
      level: 'warn',
      message: `post-task-verify ${String(opts.cwd)}: baseline still red but task started on broken baseline — preserving verdict`,
      at: deps.clock(),
    });
  } else if (attribution === 'fixed-baseline') {
    deps.eventBus.publish({
      type: 'log',
      level: 'info',
      message: `post-task-verify ${String(opts.cwd)}: fixed pre-existing failure (exit=0)`,
      at: deps.clock(),
    });
  } else if (run.outcome === SPAWN_ERROR_OUTCOME) {
    deps.eventBus.publish({
      type: 'log',
      level: 'warn',
      message: `post-task-verify ${String(opts.cwd)}: spawn-error — ${spawnErrorMessage ?? 'unknown spawn error'}; attribution skipped`,
      at: deps.clock(),
    });
  }
};

/**
 * Factory for the leaf's `execute`. Threads `deps` / `opts` / `taskId` once so the returned
 * closure matches {@link LeafUseCase}'s `(input, signal) => Promise<Result<LeafOutput, DomainError>>`
 * shape. Sequences the steps documented on {@link postTaskVerifyLeaf}: zero-turn short-circuit,
 * run the gates, propagate cancellation, persist the audit log, record + attribute the run, log
 * the outcome, then project the final {@link LeafOutput}.
 */
const createPostTaskVerifyExecute =
  (deps: PostTaskVerifyLeafDeps, opts: PostTaskVerifyLeafOpts, taskId: TaskId) =>
  async (input: LeafInput, signal?: AbortSignal): Promise<Result<LeafOutput, DomainError>> => {
    if (input.preVerifyBlockedZeroTurn) {
      return Result.ok(buildZeroTurnSkippedResult(deps, input.task));
    }

    const { run, rawOutput, spawnErrorMessage } = await runPostVerifyGates(deps, opts, signal);

    // Cancellation propagates verbatim. `runVerifyScriptUseCase` folds a runner
    // `Result.error` into a `spawn-error` row, so the abort would otherwise be swallowed as an
    // unknown-attribution outcome. Detect the cancel at the leaf boundary and surface the
    // codebase's transparently-propagated `AbortError` — the chain tears down rather than
    // recording a misleading spawn-error attribution.
    if (signal?.aborted === true) {
      return Result.error(
        new AbortError({
          elementName: `post-task-verify-${String(taskId)}`,
          reason: 'aborted during post-task verify',
        })
      );
    }

    if (opts.sprintDir !== undefined && rawOutput.length > 0) {
      await persistPostVerifyLog(deps, opts, input.task, rawOutput);
    }

    const recorded = await recordVerifyRun(deps, input, run, taskId);
    if (!recorded.ok) return Result.error(recorded.error);

    logAttributionOutcome(deps, opts, run, recorded.value.attribution, spawnErrorMessage);

    return Result.ok({
      task: recorded.value.task,
      run,
      rawOutput,
      ...(spawnErrorMessage !== undefined ? { spawnErrorMessage } : {}),
      ...(recorded.value.attribution !== undefined ? { attribution: recorded.value.attribution } : {}),
    });
  };

/** Project ctx → {@link LeafInput}. See the field docs on {@link LeafInput} for the derivation rules. */
const resolveLeafInput = (ctx: ImplementCtx, taskId: TaskId): LeafInput => {
  if (ctx.currentTask === undefined || ctx.currentTask.id !== taskId) {
    throw new InvalidStateError({
      entity: 'chain',
      currentState: 'pre-post-task-verify',
      attemptedAction: `post-task-verify-${String(taskId)}`,
      message: `post-task-verify-${String(taskId)}: ctx.currentTask is missing or mismatched`,
    });
  }
  if (ctx.currentTask.status !== 'in_progress') {
    throw new InvalidStateError({
      entity: 'task',
      currentState: ctx.currentTask.status,
      attemptedAction: `post-task-verify-${String(taskId)}`,
      message: `post-task-verify-${String(taskId)}: expected in_progress task — got '${ctx.currentTask.status}'`,
    });
  }
  // Zero-turn discriminant: a block reason is on ctx AND no generator turn ran this attempt.
  // `start-attempt` resets `genEvalTurn` to undefined per attempt and the generator leaf bumps
  // it to ≥1 on its first turn, so `genEvalTurn === undefined` is precisely "zero turns ran" —
  // the pre-task-verify hard-block case. A turn-1 generator self-block has `genEvalTurn === 1`
  // and falls through to the real verify script.
  const preVerifyBlockedZeroTurn = ctx.lastBlockReason !== undefined && ctx.genEvalTurn === undefined;
  return {
    task: ctx.currentTask,
    sprintId: ctx.sprintId,
    preVerifyBlockedZeroTurn,
    ...(ctx.lastPreVerifyOutcome !== undefined ? { preOutcome: ctx.lastPreVerifyOutcome } : {}),
  };
};

/**
 * Merge the use-case's {@link LeafOutput} into ctx: derive the legacy `lastVerifyResult` shape,
 * the block/retry decision (see the policy table on {@link postTaskVerifyLeaf}), and carry
 * `priorPostVerifyOutcome` forward for the next task's pre-task-verify short-circuit.
 */
const projectLeafOutput = (ctx: ImplementCtx, out: LeafOutput, opts: PostTaskVerifyLeafOpts): ImplementCtx => {
  const verifyResult = legacyVerifyResult(out.run, out.rawOutput, out.spawnErrorMessage);
  const tasks = (ctx.tasks ?? []).map((t) => (t.id === out.task.id ? (out.task as Task) : t));
  // Default policy: a red post-verify blocks the task — the AI's `task-verified`
  // self-report is overruled by the harness's independent verdict. The ONE escape hatch
  // is `attribution === 'baseline-broken'`: when both pre and post ran red, we have
  // explicit evidence the failure pre-existed the AI's work, so we preserve the AI's
  // verdict (the operator can fix the baseline without losing the AI's work).
  //
  //   - clean           — no block (post is green)
  //   - regressed       — BLOCK with explicit "regressed baseline" reason
  //   - fixed-baseline  — no block (post is green)
  //   - baseline-broken — no block (escape hatch; preserve AI's verdict)
  //   - undefined       — BLOCK on raw red post (no pre-verify evidence to clear it)
  const isRed = out.run.outcome === 'failed' || out.run.outcome === SPAWN_ERROR_OUTCOME;
  const shouldBlock = isRed && out.attribution !== 'baseline-broken';
  const blockReason = shouldBlock
    ? out.attribution === 'regressed'
      ? `verify script regressed baseline (exit=${String(out.run.exitCode)}); harness will not commit on red`
      : `verify script failed (exit=${String(out.run.exitCode)}); harness will not commit on red`
    : undefined;
  // Bounded red-post-verify RETRY (T6). ONLY a `'regressed'` attribution (an evaluator-passed
  // attempt that broke a GREEN baseline) qualifies — not raw red (no pre-verify evidence),
  // `baseline-broken` (pre-existing failure, no block at all), `clean`, or `fixed-baseline`.
  // While the task's attempt budget remains we also set `lastShouldFailAttempt`: settle's
  // PRECEDENCE then keeps the task in_progress for one more attempt (commit was already skipped
  // by the block guard; the retry-diff quarantine stashes the rejected diff). On the last
  // allowed attempt `budgetRemains` is false → block only, matching today's behaviour. The
  // running attempt counts as spent (start-attempt appended it), so a 3rd-of-3 attempt blocks.
  const grantRetry = out.attribution === 'regressed' && budgetRemains(out.task, opts.maxAttempts);
  return {
    ...ctx,
    currentTask: out.task,
    tasks,
    lastVerifyResult: verifyResult,
    // Carry the (cwd, outcome) tuple onto ctx so the NEXT task's pre-task-verify can
    // short-circuit when this post ran green AND its working tree is still clean. The
    // pre-task-verify leaf re-checks the tree itself via `git status --porcelain` — this
    // field only asserts "the script ran here and got this outcome." Survives
    // `settle-attempt` (which clears per-attempt fields only).
    priorPostVerifyOutcome: { cwd: opts.cwd, outcome: out.run.outcome },
    ...(blockReason !== undefined ? { lastBlockReason: blockReason } : {}),
    ...(grantRetry ? { lastShouldFailAttempt: true } : {}),
  };
};

export const postTaskVerifyLeaf = (
  deps: PostTaskVerifyLeafDeps,
  opts: PostTaskVerifyLeafOpts,
  taskId: TaskId
): Element<ImplementCtx> =>
  leaf<ImplementCtx, LeafInput, LeafOutput>(`post-task-verify-${String(taskId)}`, {
    useCase: { execute: createPostTaskVerifyExecute(deps, opts, taskId) },
    input: (ctx) => resolveLeafInput(ctx, taskId),
    output: (ctx, out) => projectLeafOutput(ctx, out, opts),
  });
