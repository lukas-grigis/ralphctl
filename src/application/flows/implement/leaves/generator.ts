import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import {
  type GeneratorTurnExit,
  type RunGeneratorTurnProps,
  runGeneratorTurnUseCase,
} from '@src/business/task/run-generator-turn.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { InProgressTask } from '@src/domain/entity/task.ts';
import { latestCritique } from '@src/domain/entity/task-graph.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type { AiSignal, HarnessSignal, LearningEntry } from '@src/domain/signal.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import { buildImplementPrompt } from '@src/integration/ai/prompts/implement/definition.ts';
import { buildImplementContinuationPrompt } from '@src/integration/ai/prompts/implement-continuation/definition.ts';
import type { BuildPromptError } from '@src/integration/ai/prompts/_engine/build-prompt.ts';
import { renderContractSectionFor } from '@src/integration/ai/contract/_engine/render-contract-section.ts';
import type { SessionId } from '@src/integration/ai/providers/_engine/session-id.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import { generatorOutputContract } from '@src/application/flows/implement/leaves/generator.contract.ts';
import { escalationBannerId } from '@src/business/task/escalation-policy.ts';
import { composeDimensionTrajectory } from '@src/business/task/dimension-trajectory.ts';
import { composeTaskEpisodes } from '@src/business/task/compose-task-episodes.ts';
import { summariseEpisodes } from '@src/business/task/episode-summary.ts';
import { composePriorLearnings } from '@src/application/flows/_shared/memory/compose-prior-learnings.ts';
import { readRoundSessionId } from '@src/application/flows/implement/leaves/round-artifacts.ts';
import { positiveCountCarry } from '@src/application/flows/implement/leaves/_shared/nudge-count-carry.ts';
import {
  readCappedProgress,
  requireRoleTurnCtx,
  resolveProjectToolingCarry,
  resolveRoundPaths,
  type RoleLeafDeps,
  runRoleTurn,
  selfContainedGrounding,
} from '@src/application/flows/implement/leaves/_shared/run-role-turn.ts';
import {
  formatPreVerifyResults,
  formatRetryFeedback,
  lastSettledAttempt,
  runningAttempt,
  VERIFY_TAIL_MAX_CHARS,
} from '@src/application/flows/implement/leaves/_shared/verify-run-summary.ts';
import type { LogTailReader } from '@src/business/io/log-tail-reader.ts';
import { createFsLogTailReader } from '@src/integration/io/read-log-tail.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';

/**
 * Chain leaf — one generator turn of the gen-eval loop. Wires the integration ports
 * (`provider`, `templateLoader`, `publishSignal`) into function-shape deps for
 * {@link runGeneratorTurnUseCase}; the use case owns the per-turn business decisions
 * (self-blocked detection + verification recording).
 *
 * File-based contract: the leaf computes this turn's round number BEFORE the provider call so
 * `session.signalsFile = <workspaceRoot>/rounds/<N>/generator/signals.json` is in place when
 * the provider writes. After the call returns the leaf reads that file, publishes each parsed
 * signal onto the application bus (TUI + progress.md fan-out), then passes the array to the use
 * case. The AI's raw prose is never materialised in node memory at this layer.
 *
 * The leaf increments `ctx.genEvalTurn` at the start so downstream consumers can report
 * "budget-exhausted at turn N". When the generator self-blocks, the leaf writes
 * `lastExitKind` + `lastBlockReason` to ctx so the surrounding `loop`'s `shouldStop` predicate
 * exits cleanly without running the evaluator.
 */
export interface GeneratorLeafDeps extends RoleLeafDeps {
  /**
   * Application bus used to publish the discrete `task-round-started` boundary marker. The
   * trace records back-to-back `generator-<id>` / `evaluator-<id>` leaves with no round number;
   * this event lets the TUI's per-task round counter survive `chain.trace` ring eviction
   * without counting trace entries (which silently shrink as eviction proceeds).
   */
  readonly eventBus: EventBus;
  /**
   * Configured gen-eval-loop budget (`settings.harness.maxTurns`). Stamped onto every
   * `task-round-started` event so subscribers can render `round N/M` without a second config
   * lookup; matches the value the surrounding `loop`'s `shouldContinue` predicate enforces.
   * Also feeds the dimension-trajectory block's budget-pressure line.
   */
  readonly maxTurns: number;
  /**
   * Best-effort reader for the trailing bytes of the harness verify-script logs under
   * `<sprintDir>/logs/verify/<taskId>/{pre,post}-attempt-<n>.log`. Used to enrich the
   * `<pre_verify_results>` (current attempt's pre-verify) and `<retry_feedback>` (prior
   * attempt's failing post-verify) prompt blocks with a short log tail. Defaults to the
   * filesystem adapter; tests inject a fake. A missing / unreadable log resolves to `undefined`
   * and the block degrades to the structured `VerifyRun` metadata alone — never throws, never
   * blocks the turn.
   */
  readonly logTailReader?: LogTailReader;
}

interface GeneratorInput {
  readonly task: InProgressTask;
  readonly turn: number;
  readonly workspaceRoot: AbsolutePath;
  /**
   * Round number for this turn — resolved upstream by `resolve-round-num-<taskId>` and
   * threaded through ctx. Single source of truth across the round's stamp + generator +
   * evaluator leaves so the meta sidecar and the spawn share the same `<N>`.
   */
  readonly roundNum: number;
  /**
   * Captured Claude `session_id` from the prior round's generator turn for this task. Forwarded
   * to `implementSession({ resume })` so the model continues a single conversational thread
   * across rounds. `undefined` on round 1 of a task (or when the prior spawn failed before
   * reporting an id) → fresh session.
   */
  readonly priorGeneratorSessionId?: SessionId;
  /**
   * Pre-composed "## Dimension trajectory" feed-forward block (principles 6 + 15) — built in the
   * input projection from `ctx.plateauHistory` via `composeDimensionTrajectory`. Empty on round 1
   * (no trajectory to diff yet). Rides inside the generator prompt's `PRIOR_CRITIQUE_SECTION` so the
   * generator sees which dimensions were fixed / still failing for N rounds / newly failing, plus a
   * plateau-budget pressure line — BEFORE the loop exits and burns an escalation rung.
   */
  readonly dimensionTrajectory?: string;
  /**
   * Pre-composed "## Learnings from prior sprints" block (principle 3, read side) — built in the
   * input projection from `ctx.priorLearnings` (the prologue's `load-learnings` loaded this
   * project's not-yet-promoted ledger insights once). Empty when the ledger is absent / empty.
   * Rides ONLY the FULL implement prompt (round 1 of a session thread); a resumed continuation
   * already carries it in-conversation, so threading it again would be redundant context.
   */
  readonly priorLearnings?: string;
  /**
   * Pre-composed `<prior_task_episodes>` block (R4, read side) — a compact summary of this sprint's
   * already-settled sibling tasks (done / blocked), built in the input projection from `ctx.tasks`
   * via `composeTaskEpisodes` + `summariseEpisodes`. Mirrors {@link priorLearnings}: rides ONLY the
   * FULL implement prompt (round 1 of a session thread); a resumed continuation already carries it
   * in-conversation. Empty when no sibling task has settled yet → the prompt slot collapses cleanly.
   */
  readonly priorEpisodes?: string;
}

interface GeneratorOutput {
  readonly task: InProgressTask;
  readonly turn: number;
  readonly exit?: GeneratorTurnExit;
  readonly proposedCommitMessage?: { readonly subject: string; readonly body?: string };
  /** On-disk round folder index written by this turn — `rounds/<N>/generator/`. */
  readonly roundNum: number;
  /**
   * `session_id` captured by the Claude adapter for THIS turn — read from
   * `rounds/<N>/generator/session-id.txt` after the spawn returns. Stamped onto ctx by the output
   * projection so the next round's generator can resume the same thread. `undefined` when the
   * adapter never reported an id (failed spawn, non-Claude provider, …).
   */
  readonly capturedSessionId?: SessionId;
  /**
   * Decision-signal bodies emitted by this turn. Empty array when the generator emitted no
   * `<decision>` signals. Accumulates onto `ctx.currentAttemptDecisions` so the journal leaf
   * can render a deduped `### Decisions` subsection for the attempt (audit-[07] — replaces
   * the deleted `decisions-log` sink with an in-memory aggregate).
   */
  readonly decisionsEmitted: readonly string[];
  /**
   * Change-signal bodies emitted by this turn — accumulates onto `ctx.currentAttemptChanges`
   * so the journal leaf can render the per-attempt `### Changes` subsection.
   */
  readonly changesEmitted: readonly string[];
  /**
   * Structured learnings emitted by this turn — each a {@link LearningEntry} (Insight + optional
   * Context + optional Applies-to). Accumulates onto `ctx.currentAttemptLearnings` so the journal
   * leaf can render the per-attempt `### Learnings` subsection and `append-learnings` can persist
   * the procedural-memory ledger rows.
   */
  readonly learningsEmitted: readonly LearningEntry[];
  /**
   * Note-signal bodies emitted by this turn — accumulates onto `ctx.currentAttemptNotes`
   * so the journal leaf can render the per-attempt `### Notes` subsection.
   */
  readonly notesEmitted: readonly string[];
  /**
   * Corrective `signals.json` nudges this turn needed (`0` on a clean first parse) — read from
   * `validateSignalsFileWithCorrectiveRetry`'s `nudgeCount`. Accumulates onto
   * `ctx.currentAttemptGeneratorNudges` so the journal leaf can render the cost-visibility clause.
   * Pure observability; never affects retry semantics.
   */
  readonly correctiveNudgeCount: number;
}

/**
 * Per-turn signal-kind distribution (R2) for the entropy-plateau heuristic — only kinds the
 * generator actually emitted this turn (count > 0). Built fresh from the turn's accumulators so the
 * stamped map reflects ONLY the current turn, never an accumulation across turns. The harness never
 * sees the AI's raw tool-use, so this signal-kind spread is the proxy the entropy guard reads.
 */
const countTurnActionKinds = (out: GeneratorOutput): Map<string, number> => {
  const counts = new Map<string, number>();
  if (out.decisionsEmitted.length > 0) counts.set('decision', out.decisionsEmitted.length);
  if (out.changesEmitted.length > 0) counts.set('change', out.changesEmitted.length);
  if (out.learningsEmitted.length > 0) counts.set('learning', out.learningsEmitted.length);
  if (out.notesEmitted.length > 0) counts.set('note', out.notesEmitted.length);
  return counts;
};

/**
 * True when this turn is a top-of-ladder same-model nudge that should arm the "change your
 * approach" directive — `escalatedFromModel === escalatedToModel` (the same-model marker, NOT a
 * model bump) AND the retry was DRIVEN by a stall (the last settled attempt carries a `plateau` /
 * `budget-exhausted` warning). The nudge stamp persists on the task, so without the warning gate a
 * later malformed retry — the evaluator's failure, with the nudge attempt's unevaluated new
 * approach in the tree — would re-inject "abandon your approach" and pivot the generator off work
 * nobody judged stalled. On a model BUMP the stronger model gets the targeted prior critique
 * instead, so the directive stays reserved for the same-model nudge where no fresh capability
 * remains.
 */
const isPlateauBreakAttempt = (task: InProgressTask): boolean => {
  const lastSettled = [...task.attempts].reverse().find((a) => a.status !== 'running');
  const stallDriven = lastSettled?.warning?.kind === 'plateau' || lastSettled?.warning?.kind === 'budget-exhausted';
  return task.escalatedFromModel !== undefined && task.escalatedFromModel === task.escalatedToModel && stallDriven;
};

/**
 * Select and build this turn's generator prompt by session continuity.
 *
 * The FIRST turn of a session thread (`priorGeneratorSessionId === undefined`) re-sends the full
 * implement brief; a RESUMED turn sends the slim continuation prompt because the conversation
 * already holds the brief, so only the per-round delta (critique, round number, plateau
 * directive) need ride. `start-attempt` clears the session slot per attempt, so attempt
 * boundaries always re-send the full context. A provider that never reports a session id keeps
 * getting the full prompt automatically — the discriminant is the same field `--resume` consumes,
 * so the prompt and the resume target can never disagree.
 *
 * `sharedValues` below is exactly what both branches send. The full-prompt-only extras —
 * prior-learnings, prior-episodes, the agent-definition section, the tooling catalog — are
 * deliberately absent from the continuation: a resumed thread already carries them
 * in-conversation, so re-sending would be redundant context.
 */
const buildGeneratorPrompt = async (
  deps: GeneratorLeafDeps,
  args: {
    readonly task: InProgressTask;
    readonly input: GeneratorInput;
    readonly outputContractSection: string;
    /**
     * Pre-rendered `<pre_verify_results>` body — the current attempt's harness pre-verify run +
     * log tail. Empty string when no pre-verify ran, which collapses the placeholder cleanly.
     */
    readonly preVerifyOutput: string;
    /**
     * Pre-rendered `<retry_feedback>` body — the prior attempt's failing post-verify run + log
     * tail. Empty string when there is no failing prior post-verify.
     */
    readonly retryFeedback: string;
  }
): Promise<Result<Prompt, BuildPromptError>> => {
  const { input } = args;
  const priorCritique = latestCritique(args.task);
  const plateauBreak = isPlateauBreakAttempt(args.task);
  // Each block rides only when non-empty so the renderer's absent-branch collapses its
  // placeholder — no orphan headings on round 1 or on a turn with no verify history. The
  // dimension trajectory rides inside PRIOR_CRITIQUE_SECTION.
  const sharedValues = {
    contractPath: join(String(input.workspaceRoot), 'contract.md'),
    progressFile: String(deps.progressFile),
    priorProgress: await readCappedProgress(String(deps.progressFile), String(args.task.id), deps.model),
    outputContractSection: args.outputContractSection,
    ...(priorCritique !== undefined ? { priorCritique } : {}),
    ...(plateauBreak ? { plateauBreak: true } : {}),
    ...(input.dimensionTrajectory !== undefined ? { dimensionTrajectory: input.dimensionTrajectory } : {}),
    ...(args.preVerifyOutput.length > 0 ? { preVerifyOutput: args.preVerifyOutput } : {}),
    ...(args.retryFeedback.length > 0 ? { retryFeedback: args.retryFeedback } : {}),
  };

  if (input.priorGeneratorSessionId !== undefined) {
    return buildImplementContinuationPrompt(deps.templateLoader, { ...sharedValues, roundNumber: input.roundNum });
  }
  return buildImplementPrompt(deps.templateLoader, {
    ...sharedValues,
    task: args.task,
    projectPath: String(deps.cwd),
    ...(deps.verifyScript !== undefined ? { verifyScript: deps.verifyScript } : {}),
    ...(await resolveProjectToolingCarry(deps)),
    ...(input.priorLearnings !== undefined ? { priorLearnings: input.priorLearnings } : {}),
    ...(input.priorEpisodes !== undefined ? { priorEpisodes: input.priorEpisodes } : {}),
    ...(deps.agentDefinition !== undefined ? { agentDefinition: deps.agentDefinition } : {}),
  });
};

/**
 * Best-effort fetch the trailing bytes of a harness verify-script log under
 * `<sprintDir>/logs/verify/<taskId>/<phase>-attempt-<n>.log`. Returns `undefined` on any failure
 * — a missing log (skipped / carried baseline produced no file), an unreadable file, or an
 * invalid path. The reader port itself never throws and resolves absent files to `undefined`, so
 * the only thing to guard here is path construction. AbortError is not produced by the reader
 * (pure file IO with no signal), so nothing to re-throw.
 */
const readVerifyLogTail = async (
  reader: LogTailReader,
  sprintDir: AbsolutePath,
  taskId: TaskId,
  phase: 'pre' | 'post',
  attemptN: number
): Promise<string | undefined> => {
  const logPath = AbsolutePath.parse(
    join(String(sprintDir), 'logs', 'verify', String(taskId), `${phase}-attempt-${String(attemptN)}.log`)
  );
  if (!logPath.ok) return undefined;
  return reader(logPath.value, VERIFY_TAIL_MAX_CHARS);
};

/**
 * Compose the two harness-verify prompt blocks for this turn (T4):
 *  - `preVerifyOutput`  — the running attempt's `phase: 'pre'` verify run + the tail of
 *    `<sprintDir>/logs/verify/<taskId>/pre-attempt-<runningAttempt.n>.log`.
 *  - `retryFeedback`    — the prior settled attempt's FAILING `phase: 'post'` verify run + the
 *    tail of `post-attempt-<priorAttempt.n>.log` (T4 stub for T6's retry policy).
 *
 * Every step is best-effort: a missing attempt, a missing verify row, or an unreadable log
 * degrades to '' (block disappears) or to the structured metadata alone. Never throws, never
 * blocks the turn. The reader is pure file IO with no abort signal, so no AbortError can surface.
 */
const composeVerifyBlocks = async (
  reader: LogTailReader,
  sprintDir: AbsolutePath,
  taskId: TaskId,
  task: InProgressTask
): Promise<{ readonly preVerifyOutput: string; readonly retryFeedback: string }> => {
  // pre-task-verify writes `pre-attempt-<attempts.length>.log`, and the running attempt IS the
  // last one, so its `n` names the current attempt's pre-verify log.
  const preVerifyAttemptN = runningAttempt(task)?.n;
  const preVerifyTail =
    preVerifyAttemptN !== undefined
      ? await readVerifyLogTail(reader, sprintDir, taskId, 'pre', preVerifyAttemptN)
      : undefined;

  // The prior settled attempt's `n` names its post-verify log.
  const priorAttemptN = lastSettledAttempt(task)?.n;
  const retryFeedbackTail =
    priorAttemptN !== undefined ? await readVerifyLogTail(reader, sprintDir, taskId, 'post', priorAttemptN) : undefined;

  return {
    preVerifyOutput: formatPreVerifyResults(task, preVerifyTail),
    retryFeedback: formatRetryFeedback(task, retryFeedbackTail),
  };
};

/**
 * Per-turn signal-text accumulators — mutated in place by {@link accumulateAndEmitSignals}.
 * `correctiveNudgeCount` is a sibling out-channel of the same shape: `callImplement` is bound to
 * the business use case's fixed `Result<readonly HarnessSignal[], DomainError>>` signature, so the
 * nudge tally rides out via this closure-captured mutable object instead of widening that return
 * type.
 */
interface GeneratorTurnAccumulators {
  readonly decisionsEmitted: string[];
  readonly changesEmitted: string[];
  readonly learningsEmitted: LearningEntry[];
  readonly notesEmitted: string[];
  correctiveNudgeCount: number;
}

/**
 * Fan out this turn's validated signals onto the application bus's typed `ai-signal` event (the
 * one harness-signal channel), while pushing each kind's text onto the turn's accumulator arrays
 * for the leaf's `execute` to read back afterward. Every validated signal kind flows — not just
 * the text-bearing subset the legacy sink mirror filtered to.
 */
const accumulateAndEmitSignals = (
  deps: Pick<GeneratorLeafDeps, 'publishSignal'>,
  signals: readonly AiSignal[],
  accumulators: GeneratorTurnAccumulators
): void => {
  for (const sig of signals) {
    deps.publishSignal(sig);
    if (sig.type === 'decision') accumulators.decisionsEmitted.push(sig.text);
    else if (sig.type === 'change') accumulators.changesEmitted.push(sig.text);
    else if (sig.type === 'learning')
      accumulators.learningsEmitted.push({
        text: sig.text,
        ...(sig.context !== undefined ? { context: sig.context } : {}),
        ...(sig.appliesTo !== undefined ? { appliesTo: sig.appliesTo } : {}),
      });
    else if (sig.type === 'note') accumulators.notesEmitted.push(sig.text);
  }
};

/**
 * Publish the discrete `task-round-started` boundary marker — fired BEFORE the AI call so the
 * TUI's per-task round counter and the persistent `chain.log` see the round-start before any of
 * this turn's generator-leaf trace entries. `attemptN` is `task.attempts.length`: the running
 * attempt was already started by `start-attempt-<taskId>` upstream, so this counts the n-th
 * attempt-within-task (1-indexed; matches `task.maxAttempts`). Also releases any prior escalation
 * banner (idempotent against an absent one — once a new round starts, the operator-facing
 * "escalated to <model>" message has served its purpose) and logs the round-start line.
 */
const announceRoundStart = (
  deps: Pick<GeneratorLeafDeps, 'eventBus' | 'clock' | 'logger' | 'maxTurns'>,
  taskId: TaskId,
  task: InProgressTask,
  roundNum: number
): void => {
  deps.eventBus.publish({
    type: 'task-round-started',
    taskId: String(taskId),
    attemptN: task.attempts.length,
    roundN: roundNum,
    totalCap: deps.maxTurns,
    at: deps.clock(),
  });
  deps.eventBus.publish({
    type: 'banner-clear',
    id: escalationBannerId(String(taskId)),
    at: deps.clock(),
  });
  deps.logger
    .named('task.round-started')
    .info(`round ${String(roundNum)}/${String(deps.maxTurns)} of attempt ${String(task.attempts.length)}`, {
      taskId: task.id,
      attemptN: task.attempts.length,
      roundN: roundNum,
      totalCap: deps.maxTurns,
    });
};

/**
 * Build this turn's `callImplement` — composes the harness-verify prompt blocks + the generator
 * prompt, then hands the rest of the turn to {@link runRoleTurn} (persist prompt, spawn, validate
 * with bounded corrective nudges, render sidecars). Returns the parsed signals for
 * `runGeneratorTurnUseCase` to interpret.
 */
const makeGeneratorCallImplement =
  (
    deps: GeneratorLeafDeps,
    taskId: TaskId,
    args: {
      readonly input: GeneratorInput;
      readonly roundNum: number;
      readonly signalsFile: AbsolutePath;
      readonly outputDir: AbsolutePath;
      readonly logTailReader: LogTailReader;
      readonly signal: AbortSignal | undefined;
      readonly accumulators: GeneratorTurnAccumulators;
    }
  ): RunGeneratorTurnProps['callImplement'] =>
  async (task) => {
    const outputContractSection = renderContractSectionFor(generatorOutputContract, args.outputDir);

    const turn = await runRoleTurn(deps, {
      role: 'generator',
      workspaceRoot: args.input.workspaceRoot,
      roundNum: args.roundNum,
      signalsFile: args.signalsFile,
      outputDir: args.outputDir,
      // Per-task generator-model escalation: when the task carries an `escalatedToModel`
      // (stamped by the prior plateau's escalation policy), spawn the generator on that
      // upgraded model instead of the configured row. Evaluator model is intentionally
      // unaffected — escalation only touches the generator role.
      model: task.escalatedToModel ?? deps.model,
      // Per-task generator-EFFORT escalation: the same-model effort rung stamps `escalatedToEffort`
      // (default → high) when the generator topped out on the model ladder but still had effort
      // headroom. Prefer it over the configured `deps.effort` at spawn — mirrors the model override
      // above. Without this read the effort bump the policy granted would never reach the spawn.
      effort: task.escalatedToEffort ?? deps.effort,
      priorSessionId: args.input.priorGeneratorSessionId,
      signal: args.signal,
      contract: generatorOutputContract,
      buildPrompt: async () => {
        // T4: surface the harness's pre-task verify result (so the generator reviews baseline
        // state instead of re-running the verify script in-turn) and the prior attempt's failing
        // post-verify (so a retry fixes the regression first). All best-effort — see helper.
        const { preVerifyOutput, retryFeedback } = await composeVerifyBlocks(
          args.logTailReader,
          deps.sprintDir,
          taskId,
          task
        );
        return buildGeneratorPrompt(deps, {
          task,
          input: args.input,
          outputContractSection,
          preVerifyOutput,
          retryFeedback,
        });
      },
      selfContainedContext: selfContainedGrounding(args.input.workspaceRoot, outputContractSection),
      onSignals: (signals) => {
        accumulateAndEmitSignals(deps, signals, args.accumulators);
      },
    });
    if (!turn.ok) return Result.error(turn.error) as Result<readonly HarnessSignal[], DomainError>;
    // Cost-visibility out-channel — see GeneratorTurnAccumulators' docstring for why this rides
    // a mutated field rather than widening `callImplement`'s return type.
    args.accumulators.correctiveNudgeCount = turn.value.nudgeCount;

    // `runGeneratorTurnUseCase` expects `readonly HarnessSignal[]`. `GeneratorContractSignal`
    // is a strict subset of `HarnessSignal`, but TS's array variance doesn't infer
    // that automatically — cast through `AiSignal[]` (the canonical union alias) to
    // keep the call site honest about the underlying domain shape.
    return Result.ok(turn.value.signals as readonly AiSignal[]) as Result<readonly HarnessSignal[], DomainError>;
  };

/**
 * Build this leaf's `execute` — resolves the round's `signals.json` path, announces the round
 * boundary, drives one generator turn via `runGeneratorTurnUseCase` (see
 * {@link makeGeneratorCallImplement}), then reads back the captured session id and the turn's
 * accumulated signal texts into {@link GeneratorOutput}.
 */
const makeGeneratorExecute =
  (
    deps: GeneratorLeafDeps,
    taskId: TaskId
  ): ((input: GeneratorInput, signal?: AbortSignal) => Promise<Result<GeneratorOutput, DomainError>>) =>
  async (input, signal) => {
    const roundNum = input.roundNum;
    const paths = resolveRoundPaths(input.workspaceRoot, roundNum, 'generator');
    if (!paths.ok) return Result.error(paths.error);

    announceRoundStart(deps, taskId, input.task, roundNum);

    // Per-turn signal accumulators — closure-captured so the leaf can stamp the
    // emitted texts onto ctx in `output(...)`. The journal leaf reads the aggregate
    // across all gen-eval rounds for the attempt.
    const accumulators: GeneratorTurnAccumulators = {
      decisionsEmitted: [],
      changesEmitted: [],
      learningsEmitted: [],
      notesEmitted: [],
      correctiveNudgeCount: 0,
    };
    const logTailReader = deps.logTailReader ?? createFsLogTailReader();
    const callImplement = makeGeneratorCallImplement(deps, taskId, {
      input,
      roundNum,
      ...paths.value,
      logTailReader,
      signal,
      accumulators,
    });

    const result = await runGeneratorTurnUseCase({
      task: input.task,
      callImplement,
      logger: deps.logger,
    });
    if (!result.ok) return Result.error(result.error);

    // Read THIS turn's captured sessionId from disk (the Claude adapter just wrote it as a
    // sibling of `signals.json` via `persistSessionIdFile`). Undefined when the spawn never
    // reported an id — left undefined so the next round cold-starts cleanly rather than
    // forwarding a stale id from a prior task.
    const capturedSessionId = await readRoundSessionId(input.workspaceRoot, roundNum, 'generator');

    return Result.ok({
      task: result.value.task,
      turn: input.turn,
      roundNum,
      ...accumulators,
      ...(result.value.exit !== undefined ? { exit: result.value.exit } : {}),
      ...(result.value.proposedCommitMessage !== undefined
        ? { proposedCommitMessage: result.value.proposedCommitMessage }
        : {}),
      ...(capturedSessionId !== undefined ? { capturedSessionId } : {}),
    });
  };

/**
 * Build this leaf's `input` projection — validates the ctx preconditions the generator turn
 * needs (`currentTask`, `taskWorkspaceRoot`, `currentRoundNum`), then composes the three
 * feed-forward prompt blocks (dimension trajectory, prior learnings, prior episodes) from pure
 * ctx reads before assembling {@link GeneratorInput}.
 */
const makeGeneratorInput =
  (
    deps: Pick<GeneratorLeafDeps, 'plateauThreshold' | 'maxTurns'>,
    taskId: TaskId
  ): ((ctx: ImplementCtx) => GeneratorInput) =>
  (ctx) => {
    const { task, workspaceRoot, roundNum } = requireRoleTurnCtx(ctx, 'generator', taskId);
    // Compose the dimension-trajectory feed-forward (principles 6 + 15) from the per-attempt
    // evaluator-turn history. Pure ctx read — `composeDimensionTrajectory` returns '' until there
    // are two turns to diff (round 1 has none), so the prompt's PRIOR_CRITIQUE_SECTION collapses
    // cleanly on the first round.
    const dimensionTrajectory = composeDimensionTrajectory({
      history: ctx.plateauHistory ?? [],
      plateauThreshold: deps.plateauThreshold,
      roundNum,
      maxTurns: deps.maxTurns,
    });
    // Cross-sprint procedural memory (principle 3) loaded once by the prologue's `load-learnings`.
    // Pure ctx read; '' when the ledger was absent/empty so the prompt placeholder collapses.
    const priorLearnings = composePriorLearnings(ctx.priorLearnings ?? []);
    // Episodic memory (R4) derived from this sprint's already-settled sibling tasks. Pure ctx
    // read; '' until a sibling has settled (done/blocked) so the prompt placeholder collapses.
    const priorEpisodes = summariseEpisodes(composeTaskEpisodes(ctx.tasks ?? [], taskId, ctx.sprintId));
    return {
      task,
      turn: (ctx.genEvalTurn ?? 0) + 1,
      workspaceRoot,
      roundNum,
      ...(ctx.priorGeneratorSessionId !== undefined ? { priorGeneratorSessionId: ctx.priorGeneratorSessionId } : {}),
      ...(dimensionTrajectory.length > 0 ? { dimensionTrajectory } : {}),
      ...(priorLearnings.length > 0 ? { priorLearnings } : {}),
      ...(priorEpisodes.length > 0 ? { priorEpisodes } : {}),
    };
  };

/**
 * Merge one generator turn's output into ctx — task/tasks list, round bookkeeping, latest
 * proposed commit message, captured session id, per-attempt signal accumulators, and the
 * per-turn action-kind distribution (R2).
 */
const generatorOutput = (ctx: ImplementCtx, out: GeneratorOutput): ImplementCtx => {
  const tasks = (ctx.tasks ?? []).map((t) => (t.id === out.task.id ? out.task : t));
  // Latest non-undefined proposed commit message wins across turns.
  const proposedCommitMessage = out.proposedCommitMessage ?? ctx.proposedCommitMessage;
  const carry = proposedCommitMessage !== undefined ? { proposedCommitMessage } : {};
  // Latest captured generator sessionId wins; only OVERWRITE when this turn produced one.
  // A turn that failed to capture an id (provider crash mid-stream) preserves whatever the
  // prior turn captured so the next round still has a thread to resume.
  const sessionCarry = out.capturedSessionId !== undefined ? { priorGeneratorSessionId: out.capturedSessionId } : {};
  // Accumulate this turn's signal texts onto the per-attempt aggregates. Cleared by the
  // progress-journal leaf after the attempt settles. Each kind has its own field on ctx so
  // the journal renderer can drop empty subsections without inspecting the signal type.
  const decisionsCarry =
    out.decisionsEmitted.length > 0
      ? { currentAttemptDecisions: [...(ctx.currentAttemptDecisions ?? []), ...out.decisionsEmitted] }
      : {};
  const changesCarry =
    out.changesEmitted.length > 0
      ? { currentAttemptChanges: [...(ctx.currentAttemptChanges ?? []), ...out.changesEmitted] }
      : {};
  const learningsCarry =
    out.learningsEmitted.length > 0
      ? { currentAttemptLearnings: [...(ctx.currentAttemptLearnings ?? []), ...out.learningsEmitted] }
      : {};
  const notesCarry =
    out.notesEmitted.length > 0
      ? { currentAttemptNotes: [...(ctx.currentAttemptNotes ?? []), ...out.notesEmitted] }
      : {};
  // Cost-visibility tally — accumulates across every turn of the attempt, same lifecycle as the
  // signal accumulators above. Zero-noise: a turn with no nudge contributes nothing (ctx field
  // stays undefined until the first nudge fires).
  const generatorNudgesCarry = positiveCountCarry(
    'currentAttemptGeneratorNudges',
    out.correctiveNudgeCount,
    ctx.currentAttemptGeneratorNudges
  );
  // Per-turn signal-kind distribution (R2) — stamped fresh every turn (overwrites the prior
  // turn's map) so the entropy-plateau heuristic in the gen-eval loop sees the current turn's
  // action diversity, never an accumulation across turns.
  const actionCountsCarry = { lastTurnActionCounts: countTurnActionKinds(out) };
  const next: ImplementCtx = {
    ...ctx,
    currentTask: out.task,
    tasks,
    genEvalTurn: out.turn,
    currentRoundNum: out.roundNum,
    ...carry,
    ...sessionCarry,
    ...decisionsCarry,
    ...changesCarry,
    ...learningsCarry,
    ...notesCarry,
    ...generatorNudgesCarry,
    ...actionCountsCarry,
  };
  if (out.exit === undefined) return next;
  // Both exit kinds stop the inner loop + skip the evaluator (both key on `lastExit`), but
  // they diverge on `lastBlockReason`:
  //  - `self-blocked` (generator emitted `<task-blocked>` / codex-copilot signals-contract
  //    failure) sets it → settle terminal-blocks the task after one attempt (unchanged).
  //  - `crashed` (watchdog kill / spawn crash) sets ONLY `lastExit`. It must NOT set
  //    `lastBlockReason`: finalize is the sole authority for whether a crash blocks (it grants
  //    a retry within maxAttempts, then blocks at the cap). Because `finalizeGenEvalLeaf` only
  //    ADDS a block reason (conditional spread) and never CLEARS a stale one, a block reason
  //    stamped here would leak past finalize into settle and wrongly terminal-block the task.
  const blockReasonCarry = out.exit.kind === 'self-blocked' ? { lastBlockReason: out.exit.reason } : {};
  return { ...next, lastExit: { kind: out.exit.kind, reason: out.exit.reason }, ...blockReasonCarry };
};

export const generatorLeaf = (deps: GeneratorLeafDeps, taskId: TaskId): Element<ImplementCtx> =>
  leaf<ImplementCtx, GeneratorInput, GeneratorOutput>(`generator-${String(taskId)}`, {
    useCase: { execute: makeGeneratorExecute(deps, taskId) },
    input: makeGeneratorInput(deps, taskId),
    output: generatorOutput,
  });
