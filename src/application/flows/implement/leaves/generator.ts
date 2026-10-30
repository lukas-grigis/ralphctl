import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import {
  type GeneratorTurnExit,
  type RunGeneratorTurnProps,
  runGeneratorTurnUseCase,
} from '@src/business/task/run-generator-turn.ts';
import { projectBlockCarry } from '@src/application/flows/implement/leaves/_shared/block-carry.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { GenEvalExit } from '@src/business/task/gen-eval-exit.ts';
import type { InProgressTask } from '@src/domain/entity/task.ts';
import { restoredWorkContext } from '@src/domain/entity/task-prior-work.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type { AiSignal, HarnessSignal } from '@src/domain/signal.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import { buildImplementPrompt } from '@src/integration/ai/prompts/implement/definition.ts';
import { buildImplementContinuationPrompt } from '@src/integration/ai/prompts/implement-continuation/definition.ts';
import { buildImplementCrashResumePrompt } from '@src/integration/ai/prompts/implement-crash-resume/definition.ts';
import type { BuildPromptError } from '@src/integration/ai/prompts/_engine/build-prompt.ts';
import { renderContractSectionFor } from '@src/integration/ai/contract/_engine/render-contract-section.ts';
import type { SessionId } from '@src/integration/ai/providers/_engine/session-id.ts';
import type { ProviderUsage } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import { generatorOutputContract } from '@src/application/flows/implement/leaves/generator.contract.ts';
import { escalationBannerId } from '@src/business/task/escalation-policy.ts';
import { generatorSpawnTarget } from '@src/application/flows/implement/leaves/_shared/role-spawn.ts';
import { renderPriorAttemptsSection } from '@src/business/task/attempt-summary.ts';
import { readReproductionSection } from '@src/application/flows/implement/leaves/reproduce.ts';
import { readRoundSessionId } from '@src/application/flows/implement/leaves/round-artifacts.ts';
import { positiveCountCarry } from '@src/application/flows/implement/leaves/_shared/nudge-count-carry.ts';
import { attemptUsageCarry } from '@src/application/flows/implement/leaves/_shared/attempt-usage-carry.ts';
import { composeGeneratorFeedForward } from '@src/application/flows/implement/leaves/_shared/compose-generator-feed-forward.ts';
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
  appendSetAsidePatchNote,
  formatPreVerifyResults,
  formatRetryFeedback,
  lastSettledAttempt,
  runningAttempt,
  VERIFY_LOG_READ_MAX_BYTES,
} from '@src/application/flows/implement/leaves/_shared/verify-run-summary.ts';
import type { LogTailReader } from '@src/business/io/log-tail-reader.ts';
import { createFsLogTailReader } from '@src/integration/io/read-log-tail.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import { rejectedDiffPatchPath, verifyLogPath } from '@src/application/flows/implement/leaves/verify-log.ts';
import { budgetedAttemptCount, latestCritique, resumesFreeAttempt } from '@src/domain/entity/task-attempts.ts';
import {
  foldSignalTexts,
  signalTexts,
  type SignalTexts,
} from '@src/application/flows/implement/leaves/_shared/signal-texts.ts';

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
   * to the spawn's `resume` so the model continues a single conversational thread
   * across rounds. `undefined` on round 1 of a task (or when the prior spawn failed before
   * reporting an id) → fresh session.
   */
  readonly priorGeneratorSessionId?: SessionId;
  /**
   * This turn resumes a thread the harness was interrupted in (see `ctx.crashResumePending`): it
   * sends the crash-resume prompt rather than the round continuation.
   */
  readonly crashResume?: boolean;
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
  /**
   * Pre-composed reproduction body (read side) — built in the input projection from
   * `ctx.reproductionArtifact` via `renderReproductionBody` when the task's guarded
   * `reproduce-<taskId>` leaf validated one. Unlike `priorLearnings` / `priorEpisodes`
   * (session-scoped, full-prompt-only), the reproduction is round-relevant on EVERY turn of the
   * attempt — the generator must keep the reproduction test passing across retries — so it rides
   * both the full and continuation prompt branches below. Undefined when the task is not
   * defect-shaped or no reproduction was validated.
   */
  readonly reproduction?: string;
}

interface GeneratorOutput extends SignalTexts {
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
   * Corrective `signals.json` nudges this turn needed (`0` on a clean first parse) — read from
   * `validateSignalsFileWithCorrectiveRetry`'s `nudgeCount`. Accumulates onto
   * `ctx.currentAttemptGeneratorNudges` so the journal leaf can render the cost-visibility clause.
   * Pure observability; never affects retry semantics.
   */
  readonly correctiveNudgeCount: number;
  /**
   * Raw cost telemetry for this turn's spawn — provider-reported token counts + harness-measured
   * wall-clock. Accumulates onto the per-attempt `ctx.currentAttempt{Input,Output}Tokens` /
   * `currentAttemptDurationMs` totals that `settle-attempt` persists onto the attempt. Absent when
   * the spawn reported none.
   */
  readonly usage?: ProviderUsage | undefined;
}

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
export const isPlateauBreakAttempt = (task: InProgressTask): boolean => {
  const lastSettled = lastSettledAttempt(task);
  const stallDriven = lastSettled?.warning?.kind === 'plateau' || lastSettled?.warning?.kind === 'budget-exhausted';
  return task.escalatedFromModel !== undefined && task.escalatedFromModel === task.escalatedToModel && stallDriven;
};

/**
 * Which prompt a turn sends: a resumed thread gets the slim continuation — or, right after a harness
 * interruption, the crash-resume prompt — and everything else (or the stale-resume cold fallback)
 * the full brief.
 */
const generatorPromptKind = (input: GeneratorInput, forceFull: boolean): 'full' | 'continuation' | 'crash-resume' => {
  if (input.priorGeneratorSessionId === undefined || forceFull) return 'full';
  return input.crashResume === true ? 'crash-resume' : 'continuation';
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
    /** Force the FULL prompt even on a resumed thread — the stale-resume `coldPrompt`. */
    readonly forceFull?: boolean;
  }
): Promise<Result<Prompt, BuildPromptError>> => {
  const { input } = args;
  const priorCritique = latestCritique(args.task);
  const plateauBreak = isPlateauBreakAttempt(args.task);
  // Select-K prior-attempt summaries (arXiv 2604.16529, PDR half) — unlike priorLearnings/priorEpisodes
  // (session-scoped, full-prompt-only), which attempts already happened on THIS task is
  // round-relevant context, so it rides both branches below. '' when no prior attempt on the
  // task has settled yet (round 1 of attempt 1), which collapses the placeholder cleanly.
  const priorAttempts = renderPriorAttemptsSection(args.task.attempts);
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
    ...(priorAttempts.length > 0 ? { priorAttempts } : {}),
    ...(input.reproduction !== undefined ? { reproduction: input.reproduction } : {}),
  };

  const kind = generatorPromptKind(input, args.forceFull === true);
  if (kind === 'crash-resume') {
    return buildImplementCrashResumePrompt(deps.templateLoader, { outputContractSection: args.outputContractSection });
  }
  if (kind === 'continuation') {
    return buildImplementContinuationPrompt(deps.templateLoader, {
      ...sharedValues,
      roundNumber: input.roundNum,
      task: args.task,
    });
  }
  // A cold turn after a restore is told the dirty tree is its own earlier, rejected draft.
  const restored = restoredWorkContext(args.task);
  return buildImplementPrompt(deps.templateLoader, {
    ...sharedValues,
    task: args.task,
    ...(restored !== undefined ? { restoredWork: restored } : {}),
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
  const logPath = verifyLogPath(sprintDir, taskId, phase, attemptN);
  if (!logPath.ok) return undefined;
  return reader(logPath.value, VERIFY_LOG_READ_MAX_BYTES);
};

/**
 * Compose the two harness-verify prompt blocks for this turn:
 *  - `preVerifyOutput`  — the running attempt's `phase: 'pre'` verify run + the tail of
 *    `<sprintDir>/logs/verify/<taskId>/pre-attempt-<runningAttempt.n>.log`.
 *  - `retryFeedback`    — the prior settled attempt's FAILING `phase: 'post'` verify run + the
 *    tail of `post-attempt-<priorAttempt.n>.log`.
 *
 * Every step is best-effort: a missing attempt, a missing verify row, or an unreadable log
 * degrades to '' (block disappears) or to the structured metadata alone. Never throws, never
 * blocks the turn. The reader is pure file IO with no abort signal, so no AbortError can surface.
 *
 * Exported so `best-of-n-candidate.ts`'s candidate spawns compose the SAME two blocks a normal
 * generator turn gets — the granted attempt's most expensive turns must see the same harness-verify
 * context, not a silently narrower prompt.
 */
export const composeVerifyBlocks = async (
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

  let retryFeedback = formatRetryFeedback(task, retryFeedbackTail);
  if (priorAttemptN !== undefined && retryFeedback.length > 0) {
    // The red-verify retry quarantine saves the set-aside diff here; the reader resolves a
    // missing file to `undefined`, so a 1-byte read is the existence probe.
    const patchPath = rejectedDiffPatchPath(sprintDir, taskId, priorAttemptN);
    if (patchPath.ok && (await reader(patchPath.value, 1)) !== undefined) {
      retryFeedback = appendSetAsidePatchNote(retryFeedback, String(patchPath.value));
    }
  }

  return {
    preVerifyOutput: formatPreVerifyResults(task, preVerifyTail),
    retryFeedback,
  };
};

/**
 * Per-turn out-channel: `callImplement` is bound to the business use case's fixed
 * `Result<readonly HarnessSignal[], DomainError>` signature, so the turn's texts, nudge tally and
 * usage ride out through this closure-captured object instead of widening that return type.
 */
interface GeneratorTurnAccumulators {
  texts: SignalTexts;
  correctiveNudgeCount: number;
  usage: ProviderUsage | undefined;
}

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
    budgetedAttemptN: budgetedAttemptCount(task),
    resumed: resumesFreeAttempt(task),
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

    const buildTurnPrompt = async (forceFull: boolean): Promise<Result<Prompt, BuildPromptError>> => {
      // Pre-task verify result + prior attempt's failing post-verify; best-effort — see helper.
      const verify = await composeVerifyBlocks(args.logTailReader, deps.sprintDir, taskId, task);
      return buildGeneratorPrompt(deps, { task, input: args.input, outputContractSection, ...verify, forceFull });
    };

    const turn = await runRoleTurn(deps, {
      role: 'generator',
      workspaceRoot: args.input.workspaceRoot,
      roundNum: args.roundNum,
      signalsFile: args.signalsFile,
      outputDir: args.outputDir,
      // Per-task escalation: an `escalatedToModel` (prior plateau's model rung, retired slugs
      // remapped) and an `escalatedToEffort` (same-model effort rung) override the configured row;
      // the effort is clamped to the resolved model so a level stamped before the clamp can't reach
      // the CLI. The evaluator model is never escalated.
      ...generatorSpawnTarget(task, deps),
      priorSessionId: args.input.priorGeneratorSessionId,
      signal: args.signal,
      contract: generatorOutputContract,
      buildPrompt: () => buildTurnPrompt(false),
      // A resumed turn sends the slim continuation; the stale-resume fallback needs the full brief.
      buildColdPrompt: () => buildTurnPrompt(true),
      selfContainedContext: selfContainedGrounding(args.input.workspaceRoot, outputContractSection),
      onSignals: (signals) => {
        for (const sig of signals) deps.publishSignal(sig);
        args.accumulators.texts = signalTexts(signals);
      },
    });
    if (!turn.ok) return Result.error(turn.error) as Result<readonly HarnessSignal[], DomainError>;
    args.accumulators.correctiveNudgeCount = turn.value.nudgeCount;
    args.accumulators.usage = turn.value.usage;

    // `runGeneratorTurnUseCase` expects `readonly HarnessSignal[]`. `GeneratorSignal`
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

    const accumulators: GeneratorTurnAccumulators = {
      texts: signalTexts([]),
      correctiveNudgeCount: 0,
      usage: undefined,
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
      ...accumulators.texts,
      correctiveNudgeCount: accumulators.correctiveNudgeCount,
      usage: accumulators.usage,
      ...(result.value.exit !== undefined ? { exit: result.value.exit } : {}),
      ...(result.value.proposedCommitMessage !== undefined
        ? { proposedCommitMessage: result.value.proposedCommitMessage }
        : {}),
      ...(capturedSessionId !== undefined ? { capturedSessionId } : {}),
    });
  };

/**
 * Build this leaf's `input` projection — validates the ctx preconditions the generator turn
 * needs (`currentTask`, `taskWorkspaceRoot`, `currentRoundNum`), then composes the feed-forward
 * prompt blocks via {@link composeGeneratorFeedForward} before assembling {@link GeneratorInput}.
 */
const makeGeneratorInput =
  (
    deps: Pick<GeneratorLeafDeps, 'clock' | 'cwd' | 'plateauThreshold' | 'maxTurns'>,
    taskId: TaskId
  ): ((ctx: ImplementCtx) => GeneratorInput) =>
  (ctx) => {
    const { task, workspaceRoot, roundNum } = requireRoleTurnCtx(ctx, 'generator', taskId);
    const feedForward = composeGeneratorFeedForward(ctx, task, taskId, deps);
    const reproduction = readReproductionSection(ctx);
    return {
      task,
      turn: (ctx.genEvalTurn ?? 0) + 1,
      workspaceRoot,
      roundNum,
      ...(ctx.priorGeneratorSessionId !== undefined ? { priorGeneratorSessionId: ctx.priorGeneratorSessionId } : {}),
      ...(ctx.crashResumePending === true ? { crashResume: true } : {}),
      ...feedForward,
      ...(reproduction !== undefined ? { reproduction } : {}),
    };
  };

/**
 * Merge one generator turn's output into ctx — task/tasks list, round bookkeeping, latest
 * proposed commit message, captured session id, per-attempt signal accumulators, and the
 * per-turn action-kind distribution.
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
  // Cost-visibility tally — accumulates across every turn of the attempt, same lifecycle as the
  // signal accumulators. Zero-noise: a turn with no nudge contributes nothing (ctx field
  // stays undefined until the first nudge fires).
  const generatorNudgesCarry = positiveCountCarry(
    'currentAttemptGeneratorNudges',
    out.correctiveNudgeCount,
    ctx.currentAttemptGeneratorNudges
  );
  // Raw cost totals for the attempt — folded across both roles' spawns; settle-attempt persists
  // them onto the settling attempt, progress-journal clears them afterwards.
  const usageCarry = attemptUsageCarry(ctx, out.usage);
  const next: ImplementCtx = {
    ...ctx,
    currentTask: out.task,
    tasks,
    genEvalTurn: out.turn,
    currentRoundNum: out.roundNum,
    crashResumePending: undefined,
    ...carry,
    ...sessionCarry,
    ...foldSignalTexts(ctx, out),
    ...generatorNudgesCarry,
    ...usageCarry,
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
  const blockReasonCarry = projectBlockCarry(out.exit);
  // A `crashed` exit carries the crash forensics (`abortCause` / `signalOrExitCode`) so the settle
  // that blocks the task once the crash budget is gone can attribute the aborted attempt. Nothing
  // was killed on a `self-blocked` exit, so that variant carries no forensics at all.
  const lastExit: GenEvalExit =
    out.exit.kind === 'crashed'
      ? {
          kind: 'crashed',
          reason: out.exit.reason,
          ...(out.exit.abortCause !== undefined ? { abortCause: out.exit.abortCause } : {}),
          ...(out.exit.signalOrExitCode !== undefined ? { signalOrExitCode: out.exit.signalOrExitCode } : {}),
        }
      : { kind: 'self-blocked', reason: out.exit.reason };
  return { ...next, lastExit, ...blockReasonCarry };
};

export const generatorLeaf = (deps: GeneratorLeafDeps, taskId: TaskId): Element<ImplementCtx> =>
  leaf<ImplementCtx, GeneratorInput, GeneratorOutput>(`generator-${String(taskId)}`, {
    useCase: { execute: makeGeneratorExecute(deps, taskId) },
    input: makeGeneratorInput(deps, taskId),
    output: generatorOutput,
    label: 'Generate',
  });
