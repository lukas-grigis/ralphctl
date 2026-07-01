import { dirname, join } from 'node:path';
import { promises as fs } from 'node:fs';
import { Result } from '@src/domain/result.ts';
import {
  type GeneratorTurnExit,
  type RunGeneratorTurnProps,
  runGeneratorTurnUseCase,
} from '@src/business/task/run-generator-turn.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { WriteFile } from '@src/business/io/write-file.ts';
import type { InProgressTask } from '@src/domain/entity/task.ts';
import { latestCritique } from '@src/domain/entity/task-graph.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { AiSignal, HarnessSignal, LearningEntry } from '@src/domain/signal.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import type { HeadlessAiProvider } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { HarnessSignalSink } from '@src/business/observability/harness-signal-sink.ts';
import { buildImplementPrompt } from '@src/integration/ai/prompts/implement/definition.ts';
import { buildImplementContinuationPrompt } from '@src/integration/ai/prompts/implement-continuation/definition.ts';
import type { BuildPromptError } from '@src/integration/ai/prompts/_engine/build-prompt.ts';
import { renderContractSectionFor } from '@src/integration/ai/contract/_engine/render-contract-section.ts';
import type { TemplateLoader } from '@src/integration/ai/prompts/_engine/template-loader.ts';
import type { SessionId } from '@src/integration/ai/providers/_engine/session-id.ts';
import { renderSidecars } from '@src/integration/ai/contract/_engine/render-sidecars.ts';
import { validateSignalsFileWithCorrectiveRetry } from '@src/integration/ai/contract/_engine/corrective-retry.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import { implementSession } from '@src/application/flows/implement/leaves/implement-session.ts';
import { generatorOutputContract } from '@src/application/flows/implement/leaves/generator.contract.ts';
import { escalationBannerId } from '@src/business/task/escalation-policy.ts';
import { composeDimensionTrajectory } from '@src/business/task/dimension-trajectory.ts';
import { composeTaskEpisodes } from '@src/business/task/compose-task-episodes.ts';
import { summariseEpisodes } from '@src/business/task/episode-summary.ts';
import { composePriorLearnings } from '@src/application/flows/_shared/memory/compose-prior-learnings.ts';
import {
  readRoundSessionId,
  roundSignalsPath,
  writeRoundPrompt,
} from '@src/application/flows/implement/leaves/round-artifacts.ts';
import { capProgressBody, progressCapBudgetForModel } from '@src/application/flows/_shared/progress/cap-progress.ts';
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
 * (`provider`, `templateLoader`, `signals`) into function-shape deps for
 * {@link runGeneratorTurnUseCase}; the use case owns the per-turn business decisions
 * (self-blocked detection + verification recording).
 *
 * File-based contract: the leaf computes this turn's round number BEFORE the provider call so
 * `session.signalsFile = <workspaceRoot>/rounds/<N>/generator/signals.json` is in place when
 * the provider writes. After the call returns the leaf reads that file, forwards each parsed
 * signal to the harness sink (TUI + progress.md fan-out), then passes the array to the use
 * case. The AI's raw prose is never materialised in node memory at this layer.
 *
 * The leaf increments `ctx.genEvalTurn` at the start so downstream consumers can report
 * "budget-exhausted at turn N". When the generator self-blocks, the leaf writes
 * `lastExitKind` + `lastBlockReason` to ctx so the surrounding `loop`'s `shouldStop` predicate
 * exits cleanly without running the evaluator.
 */
export interface GeneratorLeafDeps {
  readonly provider: HeadlessAiProvider;
  readonly templateLoader: TemplateLoader;
  readonly signals: HarnessSignalSink;
  /**
   * Output port used to write harness-rendered sidecars (`commit-message.txt`) post-spawn.
   * Per audit-[09], the AI only writes `signals.json`; the harness derives every other on-
   * disk artifact from the validated signal array. Threaded through from the flow factory's
   * `deps.writeFile` (atomic write-to-temp+rename in production; in-memory recorder in tests).
   */
  readonly writeFile: WriteFile;
  readonly cwd: AbsolutePath;
  /**
   * Sprint directory — mounted as a second `--add-dir` on every implement spawn so the AI
   * can read sprint-wide artifacts (`progress.md` in particular) that live outside the
   * per-task sandbox. Threaded down from the flow factory.
   */
  readonly sprintDir: AbsolutePath;
  /**
   * Absolute path to `<sprintDir>/progress.md` — passed straight to `buildImplementPrompt`'s
   * `progressFile` slot so the AI's prompt names the journal file it must read for prior
   * context (audit-[07]). The file is materialised by `create-sprint`'s init-progress-journal
   * leaf and grows append-only thereafter; the implement chain never writes the header itself.
   */
  readonly progressFile: AbsolutePath;
  readonly model: string;
  /** Optional reasoning / effort level forwarded into every `implementSession` AiSession. */
  readonly effort?: string;
  readonly verifyScript?: string;
  readonly clock: () => IsoTimestamp;
  readonly logger: Logger;
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
   */
  readonly maxTurns: number;
  /**
   * Configured plateau threshold (`settings.harness.plateauThreshold`). Used by the input
   * projection to compose the dimension-trajectory block's budget-pressure line — the loop
   * plateau-exits after this many consecutive stalled rounds, so the generator gets the warning
   * one round early. Matches the value the evaluator leaf feeds the plateau predicate.
   */
  readonly plateauThreshold: number;
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
 * Read the current `progress.md` body to inline into the prompt, CAPPED to the sprint header,
 * ALL of the current task's own attempt sections, and the last N other-task sections (see
 * {@link capProgressBody}). `progress.md` is sprint-wide and append-only, so a late-sprint
 * journal is dozens of sections long; inlining the whole body into every generator turn grew
 * token cost superlinearly. The cap bounds breadth across siblings — the current task's own
 * history rides in full because its earlier warnings / escalations / remedies are the depth the
 * next attempt must honour — while the FULL file stays on disk, reachable to the AI via the
 * `sprintDir` `--add-dir` mount named in the prompt, with every elision marked in place. Applied
 * to both the full implement prompt (round 1 / fresh session) and the continuation prompt.
 *
 * Best-effort: a missing / unreadable file returns the empty string so the template's
 * surrounding prose handles the empty case without a per-flow special branch. The current task's
 * own history is matched on its STABLE id (not its name); the sibling breadth bound scales to the
 * configured generator model's context window.
 */
const readCappedProgress = async (path: string, currentTaskId: string, model: string): Promise<string> => {
  try {
    return capProgressBody(await fs.readFile(path, 'utf8'), {
      currentTaskId,
      recentBudgetTokens: progressCapBudgetForModel(model),
    });
  } catch {
    return '';
  }
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
 * Shared between both branches:
 *  - `priorProgress` — the capped sprint-journal excerpt (full file stays on disk).
 *  - `plateauBreak` — see {@link isPlateauBreakAttempt} for the same-model-nudge arming rule.
 *  - the `<pre_verify_results>` / `<retry_feedback>` verify blocks — already composed by the leaf
 *    (best-effort log reads) and passed in as `preVerifyOutput` / `retryFeedback`.
 */
const buildGeneratorPrompt = async (
  deps: Pick<GeneratorLeafDeps, 'templateLoader' | 'cwd' | 'progressFile' | 'verifyScript' | 'model'>,
  args: {
    readonly task: InProgressTask;
    readonly workspaceRoot: AbsolutePath;
    readonly roundNum: number;
    readonly outputContractSection: string;
    readonly priorGeneratorSessionId: SessionId | undefined;
    /**
     * Pre-composed dimension-trajectory block (round 2+) — threaded into the builder's
     * `dimensionTrajectory` slot only when non-empty so the `PRIOR_CRITIQUE_SECTION` placeholder
     * collapses cleanly on round 1.
     */
    readonly dimensionTrajectory: string;
    /**
     * Pre-composed prior-learnings block — threaded into the FULL implement prompt's
     * `priorLearnings` slot only when non-empty. Ignored on the continuation branch (the resumed
     * thread already carries it).
     */
    readonly priorLearnings: string;
    /**
     * Pre-composed prior-episodes block (R4) — threaded into the FULL implement prompt's
     * `priorEpisodes` slot only when non-empty. Ignored on the continuation branch (the resumed
     * thread already carries it), exactly like `priorLearnings`.
     */
    readonly priorEpisodes: string;
    /**
     * Pre-rendered `<pre_verify_results>` body — the current attempt's harness pre-verify run +
     * log tail (T4). Empty string when no pre-verify ran. Passed through to the builder's
     * `preVerifyOutput` slot only when non-empty so the placeholder collapses cleanly otherwise.
     */
    readonly preVerifyOutput: string;
    /**
     * Pre-rendered `<retry_feedback>` body — the prior attempt's failing post-verify run + log
     * tail (T4 stub for T6). Empty string when there is no failing prior post-verify.
     */
    readonly retryFeedback: string;
  }
): Promise<Result<Prompt, BuildPromptError>> => {
  const priorCritique = latestCritique(args.task);
  const priorProgress = await readCappedProgress(String(deps.progressFile), String(args.task.id), deps.model);
  const contractPath = join(String(args.workspaceRoot), 'contract.md');
  const plateauBreak = isPlateauBreakAttempt(args.task);

  // Thread the verify blocks through only when non-empty so the renderer's absent-branch
  // collapses the `<pre_verify_results>` / `<retry_feedback>` placeholders cleanly.
  const preVerifyCarry = args.preVerifyOutput.length > 0 ? { preVerifyOutput: args.preVerifyOutput } : {};
  const retryFeedbackCarry = args.retryFeedback.length > 0 ? { retryFeedback: args.retryFeedback } : {};
  // Dimension trajectory rides inside PRIOR_CRITIQUE_SECTION — thread only when non-empty so the
  // round-1 case (no trajectory to diff) collapses the section without an orphan heading.
  const trajectoryCarry = args.dimensionTrajectory.length > 0 ? { dimensionTrajectory: args.dimensionTrajectory } : {};
  // Prior-learnings rides ONLY the full prompt (continuation already carries it in-conversation).
  const priorLearningsCarry = args.priorLearnings.length > 0 ? { priorLearnings: args.priorLearnings } : {};
  // Prior-episodes (R4) rides ONLY the full prompt — same rule as prior-learnings.
  const priorEpisodesCarry = args.priorEpisodes.length > 0 ? { priorEpisodes: args.priorEpisodes } : {};

  if (args.priorGeneratorSessionId === undefined) {
    return buildImplementPrompt(deps.templateLoader, {
      task: args.task,
      projectPath: String(deps.cwd),
      contractPath,
      progressFile: String(deps.progressFile),
      priorProgress,
      outputContractSection: args.outputContractSection,
      ...(deps.verifyScript !== undefined ? { verifyScript: deps.verifyScript } : {}),
      ...(priorCritique !== undefined ? { priorCritique } : {}),
      ...(plateauBreak ? { plateauBreak: true } : {}),
      ...trajectoryCarry,
      ...priorLearningsCarry,
      ...priorEpisodesCarry,
      ...preVerifyCarry,
      ...retryFeedbackCarry,
    });
  }
  return buildImplementContinuationPrompt(deps.templateLoader, {
    roundNumber: args.roundNum,
    contractPath,
    progressFile: String(deps.progressFile),
    priorProgress,
    outputContractSection: args.outputContractSection,
    ...(priorCritique !== undefined ? { priorCritique } : {}),
    ...(plateauBreak ? { plateauBreak: true } : {}),
    ...trajectoryCarry,
    ...preVerifyCarry,
    ...retryFeedbackCarry,
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

export const generatorLeaf = (deps: GeneratorLeafDeps, taskId: TaskId): Element<ImplementCtx> =>
  leaf<ImplementCtx, GeneratorInput, GeneratorOutput>(`generator-${String(taskId)}`, {
    useCase: {
      execute: async (input, signal) => {
        const roundNum = input.roundNum;
        const signalsFilePath = AbsolutePath.parse(roundSignalsPath(input.workspaceRoot, roundNum, 'generator'));
        if (!signalsFilePath.ok) return Result.error(signalsFilePath.error);
        const signalsFile = signalsFilePath.value;

        // Discrete boundary marker — fired BEFORE the AI call so the TUI's per-task round
        // counter and the persistent `chain.log` see the round-start before any of its
        // generator-leaf trace entries. `attemptN` is `task.attempts.length`: the running
        // attempt was already started by `start-attempt-<taskId>` upstream, so this counts the
        // n-th attempt-within-task (1-indexed; matches `task.maxAttempts`).
        deps.eventBus.publish({
          type: 'task-round-started',
          taskId: String(taskId),
          attemptN: input.task.attempts.length,
          roundN: roundNum,
          totalCap: deps.maxTurns,
          at: deps.clock(),
        });
        // Release any prior escalation banner — once a new generator round starts on this
        // task, the operator-facing "escalated to <model>" message has served its purpose and
        // shouldn't hang around blocking the banner slot. Idempotent against an absent banner.
        deps.eventBus.publish({
          type: 'banner-clear',
          id: escalationBannerId(String(taskId)),
          at: deps.clock(),
        });
        deps.logger
          .named('task.round-started')
          .info(`round ${String(roundNum)}/${String(deps.maxTurns)} of attempt ${String(input.task.attempts.length)}`, {
            taskId: input.task.id,
            attemptN: input.task.attempts.length,
            roundN: roundNum,
            totalCap: deps.maxTurns,
          });

        // `outputDir` is the per-round directory (`rounds/<N>/generator/`); `validateSignalsFile`
        // resolves `<outputDir>/signals.json` and `renderSidecars` writes harness-rendered
        // sidecars into the same directory. We derive it once from `signalsFile` so the two
        // paths stay structurally coupled.
        const outputDirPath = AbsolutePath.parse(dirname(String(signalsFile)));
        if (!outputDirPath.ok) return Result.error(outputDirPath.error);
        const outputDir = outputDirPath.value;

        // Per-turn signal accumulators — closure-captured so the leaf can stamp the
        // emitted texts onto ctx in `output(...)`. The journal leaf reads the aggregate
        // across all gen-eval rounds for the attempt.
        const decisionsEmitted: string[] = [];
        const changesEmitted: string[] = [];
        const learningsEmitted: LearningEntry[] = [];
        const notesEmitted: string[] = [];
        const logTailReader = deps.logTailReader ?? createFsLogTailReader();
        const callImplement: RunGeneratorTurnProps['callImplement'] = async (task) => {
          const outputContractSection = renderContractSectionFor(generatorOutputContract, outputDir);

          // T4: surface the harness's pre-task verify result (so the generator reviews baseline
          // state instead of re-running the verify script in-turn) and the prior attempt's failing
          // post-verify (so a retry fixes the regression first). All best-effort — see helper.
          const { preVerifyOutput, retryFeedback } = await composeVerifyBlocks(
            logTailReader,
            deps.sprintDir,
            taskId,
            task
          );

          const prompt = await buildGeneratorPrompt(deps, {
            task,
            workspaceRoot: input.workspaceRoot,
            roundNum,
            outputContractSection,
            priorGeneratorSessionId: input.priorGeneratorSessionId,
            dimensionTrajectory: input.dimensionTrajectory ?? '',
            priorLearnings: input.priorLearnings ?? '',
            priorEpisodes: input.priorEpisodes ?? '',
            preVerifyOutput,
            retryFeedback,
          });
          if (!prompt.ok) return Result.error(prompt.error) as Result<readonly HarnessSignal[], DomainError>;
          // Persist the rendered prompt under `rounds/<N>/generator/prompt.md` BEFORE the AI
          // call so a crash mid-spawn still leaves the prompt that triggered it on disk for
          // post-hoc replay. Best-effort: the writer logs and swallows on failure (the audit
          // trail must never take down the chain).
          await writeRoundPrompt(input.workspaceRoot, roundNum, 'generator', String(prompt.value), deps.logger);

          // Per-task generator-model escalation: when the task carries an `escalatedToModel`
          // (stamped by the prior plateau's escalation policy), spawn the generator on that
          // upgraded model instead of the configured row. Evaluator model is intentionally
          // unaffected — escalation only touches the generator role.
          const effectiveModel = task.escalatedToModel ?? deps.model;
          const spawn = await deps.provider.generate(
            implementSession(
              input.workspaceRoot,
              deps.cwd,
              deps.sprintDir,
              prompt.value,
              effectiveModel,
              signalsFile,
              'generator',
              input.priorGeneratorSessionId,
              deps.effort,
              signal
            )
          );
          if (!spawn.ok) return Result.error(spawn.error);

          // Validate `signals.json` against the generator contract. On a RECOVERABLE failure
          // (signals-missing / invalid-json / schema-mismatch) re-prompt the generator ONCE on
          // the resumed session with a corrective message + the Zod issue list, then re-validate.
          // `runGeneratorTurnUseCase` converts a still-failing validation into a `self-blocked`
          // exit (task settles as blocked, run continues); only a fatal `Aborted`/`RateLimit`
          // propagates and aborts the run.
          const validated = await validateSignalsFileWithCorrectiveRetry(
            {
              outputDir,
              logger: deps.logger,
              // Self-containment for a COLD corrective spawn (no resumable id / codex stale-resume
              // fallback): the per-round output contract + the on-disk task spec, so a fresh
              // session re-reads its grounding instead of emitting signals from the error text.
              selfContainedContext: [
                `Task spec (read it): \`${join(String(input.workspaceRoot), 'contract.md')}\``,
                '',
                outputContractSection,
              ].join('\n'),
              reinvoke: async (corrective) => {
                // Resume the generator's just-spawned thread so the corrective lands as a
                // follow-up turn. Falls back to the prior-round id when this spawn never
                // reported one to disk.
                const resume =
                  (await readRoundSessionId(input.workspaceRoot, roundNum, 'generator')) ??
                  input.priorGeneratorSessionId;
                const respawn = await deps.provider.generate(
                  implementSession(
                    input.workspaceRoot,
                    deps.cwd,
                    deps.sprintDir,
                    corrective as Prompt,
                    effectiveModel,
                    signalsFile,
                    'generator',
                    resume,
                    deps.effort,
                    signal
                  )
                );
                return respawn.ok ? Result.ok(undefined) : Result.error(respawn.error);
              },
            },
            generatorOutputContract
          );
          if (!validated.ok) return Result.error(validated.error);
          const signals = validated.value;

          // Fan out to BOTH the legacy `HarnessSignalSink` (TUI panels, decisions-log) and
          // the application bus's typed `ai-signal` event. The bus carries every kind the
          // contract accepts; the sink keeps its existing per-kind consumers happy until
          // Wave 6 collapses the two paths.
          for (const sig of signals) {
            deps.signals.emit(sig);
            deps.eventBus.publish({ type: 'ai-signal', signal: sig, source: 'generator' });
            if (sig.type === 'decision') decisionsEmitted.push(sig.text);
            else if (sig.type === 'change') changesEmitted.push(sig.text);
            else if (sig.type === 'learning')
              learningsEmitted.push({
                text: sig.text,
                ...(sig.context !== undefined ? { context: sig.context } : {}),
                ...(sig.appliesTo !== undefined ? { appliesTo: sig.appliesTo } : {}),
              });
            else if (sig.type === 'note') notesEmitted.push(sig.text);
          }

          // Render harness-owned sidecars (`commit-message.txt` when present). Write
          // failures log warn inside `renderSidecars`; the helper always returns
          // `Result.ok` (sidecars are operator UX only — downstream leaves read in-memory
          // signals from ctx, never the sidecar file).
          await renderSidecars(deps.writeFile, outputDir, signals, generatorOutputContract.sidecars, deps.logger);

          // `runGeneratorTurnUseCase` expects `readonly HarnessSignal[]`. `GeneratorContractSignal`
          // is a strict subset of `HarnessSignal`, but TS's array variance doesn't infer
          // that automatically — cast through `AiSignal[]` (the canonical union alias) to
          // keep the call site honest about the underlying domain shape.
          return Result.ok(signals as readonly AiSignal[]) as Result<readonly HarnessSignal[], DomainError>;
        };

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
          decisionsEmitted,
          changesEmitted,
          learningsEmitted,
          notesEmitted,
          ...(result.value.exit !== undefined ? { exit: result.value.exit } : {}),
          ...(result.value.proposedCommitMessage !== undefined
            ? { proposedCommitMessage: result.value.proposedCommitMessage }
            : {}),
          ...(capturedSessionId !== undefined ? { capturedSessionId } : {}),
        });
      },
    },
    input: (ctx) => {
      const PRE_GENERATOR_STATE = 'pre-generator';
      if (ctx.currentTask === undefined || ctx.currentTask.id !== taskId) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: PRE_GENERATOR_STATE,
          attemptedAction: `generator-${String(taskId)}`,
          message: `generator-${String(taskId)}: ctx.currentTask missing or mismatched`,
        });
      }
      if (ctx.currentTask.status !== 'in_progress') {
        throw new InvalidStateError({
          entity: 'task',
          currentState: ctx.currentTask.status,
          attemptedAction: `generator-${String(taskId)}`,
          message: `generator-${String(taskId)}: expected in_progress task`,
        });
      }
      if (ctx.taskWorkspaceRoot === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: PRE_GENERATOR_STATE,
          attemptedAction: `generator-${String(taskId)}`,
          message: `generator-${String(taskId)}: ctx.taskWorkspaceRoot missing — buildTaskWorkspaceLeaf must run first`,
        });
      }
      if (ctx.currentRoundNum === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: PRE_GENERATOR_STATE,
          attemptedAction: `generator-${String(taskId)}`,
          message: `generator-${String(taskId)}: ctx.currentRoundNum missing — resolve-round-num must run first`,
        });
      }
      // Compose the dimension-trajectory feed-forward (principles 6 + 15) from the per-attempt
      // evaluator-turn history. Pure ctx read — `composeDimensionTrajectory` returns '' until there
      // are two turns to diff (round 1 has none), so the prompt's PRIOR_CRITIQUE_SECTION collapses
      // cleanly on the first round.
      const dimensionTrajectory = composeDimensionTrajectory({
        history: ctx.plateauHistory ?? [],
        plateauThreshold: deps.plateauThreshold,
        roundNum: ctx.currentRoundNum,
        maxTurns: deps.maxTurns,
      });
      // Cross-sprint procedural memory (principle 3) loaded once by the prologue's `load-learnings`.
      // Pure ctx read; '' when the ledger was absent/empty so the prompt placeholder collapses.
      const priorLearnings = composePriorLearnings(ctx.priorLearnings ?? []);
      // Episodic memory (R4) derived from this sprint's already-settled sibling tasks. Pure ctx
      // read; '' until a sibling has settled (done/blocked) so the prompt placeholder collapses.
      const priorEpisodes = summariseEpisodes(composeTaskEpisodes(ctx.tasks ?? [], taskId, ctx.sprintId));
      return {
        task: ctx.currentTask,
        turn: (ctx.genEvalTurn ?? 0) + 1,
        workspaceRoot: ctx.taskWorkspaceRoot,
        roundNum: ctx.currentRoundNum,
        ...(ctx.priorGeneratorSessionId !== undefined ? { priorGeneratorSessionId: ctx.priorGeneratorSessionId } : {}),
        ...(dimensionTrajectory.length > 0 ? { dimensionTrajectory } : {}),
        ...(priorLearnings.length > 0 ? { priorLearnings } : {}),
        ...(priorEpisodes.length > 0 ? { priorEpisodes } : {}),
      };
    },
    output: (ctx, out) => {
      const tasks = (ctx.tasks ?? []).map((t) => (t.id === out.task.id ? out.task : t));
      // Latest non-undefined proposed commit message wins across turns.
      const proposedCommitMessage = out.proposedCommitMessage ?? ctx.proposedCommitMessage;
      const carry = proposedCommitMessage !== undefined ? { proposedCommitMessage } : {};
      // Latest captured generator sessionId wins; only OVERWRITE when this turn produced one.
      // A turn that failed to capture an id (provider crash mid-stream) preserves whatever the
      // prior turn captured so the next round still has a thread to resume.
      const sessionCarry =
        out.capturedSessionId !== undefined ? { priorGeneratorSessionId: out.capturedSessionId } : {};
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
      // Per-turn signal-kind distribution (R2) — stamped fresh every turn (overwrites the prior
      // turn's map) so the entropy-plateau heuristic in the gen-eval loop sees the current turn's
      // action diversity, never an accumulation across turns.
      const actionCountsCarry = { lastTurnActionCounts: countTurnActionKinds(out) };
      if (out.exit !== undefined) {
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
        return {
          ...ctx,
          currentTask: out.task,
          tasks,
          genEvalTurn: out.turn,
          currentRoundNum: out.roundNum,
          lastExit: { kind: out.exit.kind, reason: out.exit.reason },
          ...blockReasonCarry,
          ...carry,
          ...sessionCarry,
          ...decisionsCarry,
          ...changesCarry,
          ...learningsCarry,
          ...notesCarry,
          ...actionCountsCarry,
        };
      }
      return {
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
        ...actionCountsCarry,
      };
    },
  });
