import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type { VerifyRunOutcome } from '@src/domain/entity/attempt.ts';
import type { InProgressTask } from '@src/domain/entity/task.ts';
import { latestCritique } from '@src/domain/entity/task-graph.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { isFatalChainError } from '@src/domain/value/error/is-fatal-chain-error.ts';
import type { AiSignal } from '@src/domain/signal.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import { loop } from '@src/application/chain/build/loop.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import type { ImplementDeps } from '@src/application/flows/implement/deps.ts';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import { FULL_AUTO } from '@src/integration/ai/providers/_engine/session-permissions.ts';
import { rootSessionId } from '@src/application/session/session.ts';
import type { SessionId } from '@src/integration/ai/providers/_engine/session-id.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import { buildImplementPrompt } from '@src/integration/ai/prompts/implement/definition.ts';
import { renderContractSectionFor } from '@src/integration/ai/contract/_engine/render-contract-section.ts';
import { validateSignalsFile } from '@src/integration/ai/contract/_engine/validate-signals-file.ts';
import { createFsLogTailReader } from '@src/integration/io/read-log-tail.ts';
import { generatorOutputContract } from '@src/application/flows/implement/leaves/generator.contract.ts';
import { renderPriorAttemptsSection } from '@src/business/task/attempt-summary.ts';
import { renderReproductionBody } from '@src/application/flows/implement/leaves/reproduce.ts';
import { composeVerifyBlocks, isPlateauBreakAttempt } from '@src/application/flows/implement/leaves/generator.ts';
import { composeGeneratorFeedForward } from '@src/application/flows/implement/leaves/_shared/compose-generator-feed-forward.ts';
import {
  readCappedProgress,
  resolveProjectToolingCarry,
} from '@src/application/flows/implement/leaves/_shared/run-role-turn.ts';
import { runPathsFor } from '@src/application/flows/_shared/allocate-run-dir.ts';
import { attributeVerify, normalizeVerifyGates, runVerifyGatesUseCase } from '@src/business/task/run-verify-script.ts';
import { runVerifyShell } from '@src/application/flows/implement/leaves/pre-task-verify.ts';
import { gitDiffFootprint, gitStashPush } from '@src/integration/io/git-operations.ts';
import { computeWorkProductFingerprint } from '@src/application/flows/implement/leaves/work-product-fingerprint.ts';
import { writeTextAtomic } from '@src/integration/io/fs.ts';
import {
  type BestOfNCandidateRecord,
  type BestOfNGenEvalOpts,
  MAX_BEST_OF_N_CANDIDATES,
  bestOfNStashMessage,
  composeCandidateSummary,
  findSignal,
  signalTexts,
} from '@src/application/flows/implement/leaves/best-of-n-record.ts';

// `MAX_BEST_OF_N_CANDIDATES` is NOT re-exported — used only internally, above, for the loop's
// static ceiling. Every current external consumer of the two types + `toBestOfNGenEvalOpts`
// reaches them through THIS re-export (not `best-of-n-record.ts` directly) — see `ctx.ts`,
// `attempt-body.ts`, `best-of-n-selection.ts`.
export {
  type BestOfNCandidateRecord,
  type BestOfNGenEvalOpts,
  toBestOfNGenEvalOpts,
} from '@src/application/flows/implement/leaves/best-of-n-record.ts';

/** Shared logger namespace for every candidate-loop log line. */
const BEST_OF_N_CANDIDATE_LOGGER = 'implement.best-of-n.candidate';

interface CandidateLeafInput {
  readonly task: InProgressTask;
  readonly sprintId: SprintId;
  readonly workspaceRoot: AbsolutePath;
  readonly index: number;
  readonly preOutcome?: VerifyRunOutcome;
  readonly priorAttempts: string;
  readonly reproduction?: string;
  /**
   * The following five fields mirror the feed-forward context `generator.ts`'s `buildGeneratorPrompt`
   * composes for a normal turn (`priorCritique`, `plateauBreak`, `dimensionTrajectory` via
   * `composeGeneratorFeedForward`, plus its `priorLearnings` / `priorEpisodes`). A best-of-N
   * candidate is granted only at the escalation ladder's top — exactly the state a normal round 1
   * WOULD render the "you have plateaued — change your approach" directive and the full prior
   * critique in. Without threading them here, the harness's most expensive turns (N full sessions
   * bought by the granted attempt) would sample with LESS context than the ordinary attempt they
   * replace — the opposite of what sampling diversity is paid for.
   */
  readonly priorCritique?: string;
  readonly plateauBreak?: boolean;
  readonly dimensionTrajectory?: string;
  readonly priorLearnings?: string;
  readonly priorEpisodes?: string;
}

/** Per-call `AiSession` for one candidate spawn — mirrors `reproduce.ts`'s `buildReproduceSession`. */
const buildCandidateSession = (opts: {
  readonly cwd: AbsolutePath;
  readonly prompt: Prompt;
  readonly model: string;
  readonly effort: string | undefined;
  readonly signalsFile: AbsolutePath;
  readonly outputDir: AbsolutePath;
  readonly bodyFile: AbsolutePath;
  readonly abortSignal: AbortSignal | undefined;
}): AiSession => {
  const chainSessionId = rootSessionId();
  return {
    prompt: opts.prompt,
    cwd: opts.cwd,
    model: opts.model,
    permissions: FULL_AUTO,
    signalsFile: opts.signalsFile,
    outputDir: opts.outputDir,
    bodyFile: opts.bodyFile,
    ...(chainSessionId !== undefined ? { chainSessionId } : {}),
    ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
    ...(opts.abortSignal !== undefined ? { abortSignal: opts.abortSignal } : {}),
  };
};

/** Outcome of one candidate's generator spawn — `undefined` on any recoverable failure. */
type SpawnOutcome =
  | { readonly kind: 'ok'; readonly signals: readonly AiSignal[]; readonly capturedSessionId?: SessionId }
  | { readonly kind: 'skip' }
  | { readonly kind: 'fatal'; readonly error: DomainError };

/** Build the candidate's prompt + persist it — the FULL implement prompt every time (each
 * candidate is an independent fresh sample, never a resumed continuation). Composes the SAME
 * harness-verify blocks (`preVerifyOutput` / `retryFeedback`) and project-tooling catalog a normal
 * generator turn gets — see `CandidateLeafInput`'s docstring for why this parity matters. */
const buildCandidatePrompt = async (
  deps: ImplementDeps,
  opts: BestOfNGenEvalOpts,
  taskId: TaskId,
  input: CandidateLeafInput,
  candidateDir: AbsolutePath
): Promise<Result<Prompt, DomainError>> => {
  const outputContractSection = renderContractSectionFor(generatorOutputContract, candidateDir);
  const priorProgress = await readCappedProgress(String(opts.progressFile), String(taskId), opts.generator.model);
  const reader = opts.logTailReader ?? createFsLogTailReader();
  const { preVerifyOutput, retryFeedback } = await composeVerifyBlocks(reader, opts.sprintDir, taskId, input.task);
  const projectToolingCarry = await resolveProjectToolingCarry({
    ...(opts.generator.agentDefinitionName !== undefined
      ? { agentDefinitionName: opts.generator.agentDefinitionName }
      : {}),
    ...(deps.skillSource !== undefined ? { skillSource: deps.skillSource } : {}),
  });
  return buildImplementPrompt(deps.templateLoader, {
    task: input.task,
    projectPath: String(opts.cwd),
    contractPath: join(String(input.workspaceRoot), 'contract.md'),
    ...(opts.verifyScript !== undefined ? { verifyScript: opts.verifyScript } : {}),
    progressFile: String(opts.progressFile),
    priorProgress,
    outputContractSection,
    ...(input.priorAttempts.length > 0 ? { priorAttempts: input.priorAttempts } : {}),
    ...(input.reproduction !== undefined ? { reproduction: input.reproduction } : {}),
    ...(input.priorCritique !== undefined ? { priorCritique: input.priorCritique } : {}),
    ...(input.plateauBreak === true ? { plateauBreak: true } : {}),
    ...(input.dimensionTrajectory !== undefined ? { dimensionTrajectory: input.dimensionTrajectory } : {}),
    ...(preVerifyOutput.length > 0 ? { preVerifyOutput } : {}),
    ...(retryFeedback.length > 0 ? { retryFeedback } : {}),
    ...(input.priorLearnings !== undefined ? { priorLearnings: input.priorLearnings } : {}),
    ...(input.priorEpisodes !== undefined ? { priorEpisodes: input.priorEpisodes } : {}),
    ...projectToolingCarry,
    ...(opts.generator.agentDefinitionSection !== undefined
      ? { agentDefinition: opts.generator.agentDefinitionSection }
      : {}),
  });
};

/** Validate the just-completed spawn's `signals.json`, publish, and detect a self-block. */
const readCandidateSignals = async (
  deps: ImplementDeps,
  taskId: TaskId,
  input: CandidateLeafInput,
  candidateDir: AbsolutePath
): Promise<SpawnOutcome> => {
  const log = deps.logger.named(BEST_OF_N_CANDIDATE_LOGGER);
  const validated = await validateSignalsFile(candidateDir, generatorOutputContract);
  if (!validated.ok) {
    log.warn(`best-of-n candidate ${String(input.index)} signals invalid for task '${String(taskId)}' — skipping`, {
      taskId: String(taskId),
      index: input.index,
      error: validated.error.message,
    });
    return { kind: 'skip' };
  }
  for (const sig of validated.value) deps.publishSignal(sig);
  const blocked = findSignal(validated.value, 'task-blocked');
  if (blocked !== undefined) {
    log.info(`best-of-n candidate ${String(input.index)} self-blocked for task '${String(taskId)}' — skipping`, {
      taskId: String(taskId),
      index: input.index,
      reason: blocked.reason,
    });
    return { kind: 'skip' };
  }
  return { kind: 'ok', signals: validated.value };
};

const runCandidateSession = async (
  deps: ImplementDeps,
  opts: BestOfNGenEvalOpts,
  taskId: TaskId,
  input: CandidateLeafInput,
  candidateDir: AbsolutePath,
  abortSignal: AbortSignal | undefined
): Promise<SpawnOutcome> => {
  const log = deps.logger.named(BEST_OF_N_CANDIDATE_LOGGER);
  const paths = runPathsFor(candidateDir);
  if (!paths.ok) return { kind: 'fatal', error: paths.error };

  const prompt = await buildCandidatePrompt(deps, opts, taskId, input, candidateDir);
  if (!prompt.ok) return { kind: 'fatal', error: prompt.error };

  const promptWrote = await writeTextAtomic(String(paths.value.promptFile), String(prompt.value));
  if (!promptWrote.ok) return { kind: 'fatal', error: promptWrote.error };

  const session = buildCandidateSession({
    cwd: opts.cwd,
    prompt: prompt.value,
    model: opts.generator.model,
    effort: opts.generator.effort,
    signalsFile: paths.value.signalsFile,
    outputDir: candidateDir,
    bodyFile: paths.value.bodyFile,
    abortSignal,
  });

  const spawn = await deps.generatorProvider.generate(session);
  if (!spawn.ok) {
    if (isFatalChainError(spawn.error)) return { kind: 'fatal', error: spawn.error };
    log.warn(`best-of-n candidate ${String(input.index)} spawn failed for task '${String(taskId)}' — skipping`, {
      taskId: String(taskId),
      index: input.index,
      error: spawn.error.message,
    });
    return { kind: 'skip' };
  }

  const outcome = await readCandidateSignals(deps, taskId, input, candidateDir);
  return outcome.kind === 'ok' && spawn.value.sessionId !== undefined
    ? { ...outcome, capturedSessionId: spawn.value.sessionId as SessionId }
    : outcome;
};

/**
 * Capture the diff STILL sitting uncommitted in `cwd` — content hash + touched file list — for
 * the verify step and the selection cascade's dedupe key. MUST run (and {@link runCandidateVerify}
 * MUST also run) BEFORE {@link restoreBaseline} pops the diff off the tree — verify has to see
 * the candidate's actual changes, not the just-restored baseline.
 */
const captureDiffMeta = async (
  deps: ImplementDeps,
  cwd: AbsolutePath
): Promise<{ readonly hadDiff: boolean; readonly contentHash?: string; readonly changedFiles: readonly string[] }> => {
  const contentHash = await computeWorkProductFingerprint(deps.gitRunner, cwd);
  const footprint = await gitDiffFootprint(deps.gitRunner, cwd);
  const changedFiles = footprint.ok ? footprint.value : [];
  return { hadDiff: changedFiles.length > 0, changedFiles, ...(contentHash !== undefined ? { contentHash } : {}) };
};

/**
 * Stash the candidate's diff under `stashMessage`, restoring the working tree to the attempt
 * baseline — the SAME `gitStashPush` seam `quarantine-retry-diff.ts` / `restore-blocked-diff.ts`
 * already use for capture/restore. Called AFTER verify has already inspected the diff. A no-op
 * on an already-clean tree (the session made no changes, or the diff was already consumed).
 *
 * FAIL LOUD on a failed stash: a candidate's diff that could not be moved out of the tree means
 * the NEXT candidate would sample against a polluted baseline (wrong `contentHash`, wrong
 * `changedFileCount`, wrong attribution — the dedupe key and the judge tournament's evidence all
 * silently corrupt), so this returns `Result.error` instead of logging-and-continuing. The caller
 * fails the whole candidate loop rather than proceed off-baseline.
 */
const restoreBaseline = async (
  deps: ImplementDeps,
  cwd: AbsolutePath,
  stashMessage: string
): Promise<Result<void, DomainError>> => {
  const stashed = await gitStashPush(deps.gitRunner, cwd, stashMessage);
  if (!stashed.ok) {
    deps.logger
      .named(BEST_OF_N_CANDIDATE_LOGGER)
      .error(
        "best-of-n candidate: stash-restore failed — the tree still carries this candidate's diff; failing the attempt rather than letting the next candidate sample off-baseline",
        { stashMessage, error: stashed.error.message }
      );
    return Result.error(stashed.error);
  }
  return Result.ok(undefined);
};

/** Persist the still-uncommitted diff to `<candidateDir>/diff.patch` — MUST run BEFORE
 * {@link restoreBaseline}, which restores the tree to baseline. Best-effort: an empty or
 * unwritable diff is silently skipped (mirrors every other harness sidecar's failure posture). */
const persistDiffPatch = async (deps: ImplementDeps, cwd: AbsolutePath, candidateDir: AbsolutePath): Promise<void> => {
  const diff = await deps.gitRunner.run(cwd, ['diff', 'HEAD']);
  if (!diff.ok || diff.value.stdout.trim().length === 0) return;
  const path = AbsolutePath.parse(join(String(candidateDir), 'diff.patch'));
  if (!path.ok) return;
  await deps.writeFile(path.value, diff.value.stdout);
};

const runCandidateVerify = async (
  deps: ImplementDeps,
  opts: BestOfNGenEvalOpts,
  changedFiles: readonly string[],
  signal: AbortSignal | undefined
): Promise<VerifyRunOutcome> => {
  const gates = normalizeVerifyGates(opts.verifyScript, opts.verifyGates);
  const scope = changedFiles.length > 0 ? changedFiles : undefined;
  const result = await runVerifyGatesUseCase({
    cwd: opts.cwd,
    phase: 'post',
    gates,
    mode: 'fail-fast',
    ...(scope !== undefined ? { scope } : {}),
    ...(opts.verifyTimeoutMs !== undefined ? { defaultTimeoutMs: opts.verifyTimeoutMs } : {}),
    clock: deps.clock,
    runShellScript: (cwd, script, scriptOpts) =>
      runVerifyShell(deps.shellScriptRunner, cwd, script, {
        ...scriptOpts,
        ...(signal !== undefined ? { signal } : {}),
      }),
    logger: deps.logger,
  });
  return result.run.outcome;
};

/**
 * Post-spawn phase: capture the diff metadata, verify it against the attempt baseline (diff
 * still in the tree), restore the tree, THEN compose the candidate's telemetry record. Split
 * out of `candidateUseCase` so that function's own branching (fatal / skip / ok) stays a flat
 * dispatch.
 */
const buildCandidateRecord = async (
  deps: ImplementDeps,
  opts: BestOfNGenEvalOpts,
  input: CandidateLeafInput,
  candidateDir: AbsolutePath,
  stashMessage: string,
  spawn: Extract<SpawnOutcome, { readonly kind: 'ok' }>,
  signal: AbortSignal | undefined
): Promise<Result<BestOfNCandidateRecord, DomainError>> => {
  await persistDiffPatch(deps, opts.cwd, candidateDir);
  const captured = await captureDiffMeta(deps, opts.cwd);
  const verifyOutcome = captured.hadDiff
    ? await runCandidateVerify(deps, opts, captured.changedFiles, signal)
    : 'skipped';
  // Restore the tree to baseline REGARDLESS of the verify outcome (or a mid-verify abort) — the
  // candidate's diff is now safely captured on disk. A FAILED restore is fatal (see
  // `restoreBaseline`'s docstring): the tree would still carry this candidate's diff, poisoning
  // whatever the next candidate samples.
  const restored = await restoreBaseline(deps, opts.cwd, stashMessage);
  if (!restored.ok) return Result.error(restored.error);
  if (signal?.aborted === true) {
    return Result.error(
      new InvalidStateError({
        entity: 'chain',
        currentState: 'best-of-n-candidate',
        attemptedAction: `best-of-n-candidate-${String(input.index)}`,
        message: 'aborted during best-of-n candidate verify',
      })
    );
  }
  const attribution = input.preOutcome !== undefined ? attributeVerify(input.preOutcome, verifyOutcome) : undefined;
  const texts = signalTexts(spawn.signals);
  const summary = composeCandidateSummary({
    hadDiff: captured.hadDiff,
    changedFiles: captured.changedFiles,
    verifyOutcome,
    ...(attribution !== undefined ? { attribution } : {}),
    ...(texts.proposedCommitMessage !== undefined ? { proposedCommitMessage: texts.proposedCommitMessage } : {}),
    changesEmitted: texts.changesEmitted,
    notesEmitted: texts.notesEmitted,
  });
  return Result.ok({
    index: input.index,
    stashMessage,
    hadDiff: captured.hadDiff,
    changedFileCount: captured.changedFiles.length,
    verifyOutcome,
    summary,
    ...(captured.contentHash !== undefined ? { contentHash: captured.contentHash } : {}),
    ...(attribution !== undefined ? { attribution } : {}),
    ...(spawn.capturedSessionId !== undefined ? { capturedSessionId: spawn.capturedSessionId } : {}),
    ...texts,
  });
};

const candidateUseCase = async (
  deps: ImplementDeps,
  opts: BestOfNGenEvalOpts,
  taskId: TaskId,
  input: CandidateLeafInput,
  signal?: AbortSignal
): Promise<Result<BestOfNCandidateRecord | undefined, DomainError>> => {
  const attemptN = input.task.attempts.length;
  const stashMessage = bestOfNStashMessage(input.sprintId, taskId, attemptN, input.index);
  const candidateDir = AbsolutePath.parse(join(String(input.workspaceRoot), 'candidates', String(input.index)));
  if (!candidateDir.ok) return Result.error(candidateDir.error);

  const spawnOutcome = await runCandidateSession(deps, opts, taskId, input, candidateDir.value, signal);
  if (spawnOutcome.kind !== 'ok') {
    // Best-effort-turned-fail-loud restore even on a fatal/skip exit: a mid-spawn abort or an
    // invalid-signals spawn can still leave partial writes; this is the SAME `restoreBaseline` the
    // success path uses below, so a failed restore fails the whole candidate loop here too rather
    // than silently leaving the tree dirty for whatever runs next.
    const restored = await restoreBaseline(deps, opts.cwd, stashMessage);
    if (!restored.ok) return Result.error(restored.error);
    return spawnOutcome.kind === 'fatal' ? Result.error(spawnOutcome.error) : Result.ok(undefined);
  }

  return buildCandidateRecord(deps, opts, input, candidateDir.value, stashMessage, spawnOutcome, signal);
};

/**
 * One iteration of the candidate-sampling loop: run one generator session (the normal implement
 * prompt), verify its diff against the attempt baseline, capture the diff + a mechanical summary,
 * then restore the tree — appending the resulting {@link BestOfNCandidateRecord} onto
 * `ctx.bestOfNCandidates`. A candidate whose session crashes / self-blocks / writes invalid
 * signals is recorded as absent (no record appended — that slot contributes nothing to the
 * selection cascade) but STILL consumes its slot: `ctx.bestOfNSampledCount` (the index source,
 * separate from the successful-record count) always advances by one, so the next iteration never
 * re-tries the same candidate index. Only a fatal chain error (abort / rate-limit-exhausted)
 * propagates, after a best-effort tree restore so an abort mid-loop never leaves the tree dirty.
 */
const bestOfNOneCandidateLeaf = (
  deps: ImplementDeps,
  opts: BestOfNGenEvalOpts,
  taskId: TaskId
): Element<ImplementCtx> =>
  leaf<ImplementCtx, CandidateLeafInput, BestOfNCandidateRecord | undefined>(`best-of-n-candidate-${String(taskId)}`, {
    useCase: { execute: (input, signal) => candidateUseCase(deps, opts, taskId, input, signal) },
    input: (ctx) => {
      if (ctx.currentTask === undefined || ctx.currentTask.id !== taskId || ctx.currentTask.status !== 'in_progress') {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-best-of-n-candidate',
          attemptedAction: `best-of-n-candidate-${String(taskId)}`,
          message: `best-of-n-candidate-${String(taskId)}: ctx.currentTask missing, mismatched, or not in_progress`,
        });
      }
      if (ctx.taskWorkspaceRoot === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-best-of-n-candidate',
          attemptedAction: `best-of-n-candidate-${String(taskId)}`,
          message: `best-of-n-candidate-${String(taskId)}: ctx.taskWorkspaceRoot is undefined`,
        });
      }
      const reproduction =
        ctx.reproductionArtifact !== undefined ? renderReproductionBody(ctx.reproductionArtifact) : undefined;
      // Same feed-forward bundle a normal generator turn gets — see `CandidateLeafInput`'s
      // docstring. `ctx.currentRoundNum` is always 1 for a candidate spawn (they only ever run in
      // round 1 of the granted attempt), but read it off ctx rather than hardcode 1 so a future
      // change to when candidates can run doesn't silently go stale here.
      const feedForward = composeGeneratorFeedForward(ctx, ctx.currentTask, taskId, ctx.currentRoundNum ?? 1, {
        cwd: opts.cwd,
        clock: deps.clock,
        plateauThreshold: deps.config.harness.plateauThreshold,
        maxTurns: deps.config.harness.maxTurns,
      });
      const priorCritique = latestCritique(ctx.currentTask);
      return {
        task: ctx.currentTask,
        sprintId: ctx.sprintId,
        workspaceRoot: ctx.taskWorkspaceRoot,
        // `bestOfNSampledCount` (attempts so far, success or not) — NOT `bestOfNCandidates.length`
        // (successful records only) — so a failed candidate's slot is never re-tried.
        index: (ctx.bestOfNSampledCount ?? 0) + 1,
        priorAttempts: renderPriorAttemptsSection(ctx.currentTask.attempts),
        ...(ctx.lastPreVerifyOutcome !== undefined ? { preOutcome: ctx.lastPreVerifyOutcome } : {}),
        ...(reproduction !== undefined ? { reproduction } : {}),
        ...(priorCritique !== undefined ? { priorCritique } : {}),
        ...(isPlateauBreakAttempt(ctx.currentTask) ? { plateauBreak: true } : {}),
        ...feedForward,
      };
    },
    output: (ctx, record) => ({
      ...ctx,
      bestOfNSampledCount: (ctx.bestOfNSampledCount ?? 0) + 1,
      ...(record !== undefined ? { bestOfNCandidates: [...(ctx.bestOfNCandidates ?? []), record] } : {}),
    }),
  });

/**
 * The candidate-sampling loop — EXACTLY the task's own granted `bestOfNGrantedCandidates`
 * iterations (the loop primitive's own iteration counter drives `shouldContinue`, capped
 * defensively at the static {@link MAX_BEST_OF_N_CANDIDATES} schema ceiling). A candidate that
 * crashes / self-blocks / writes invalid signals still consumes one of the n iterations — it
 * simply contributes no record to the selection cascade — matching "one attempt samples N
 * candidates," not "keep sampling until N succeed."
 *
 * Does NOT itself persist the grant's consumption — `persistBestOfNGrantConsumedLeaf`
 * (`best-of-n-grant-consumed.ts`) must run exactly ONCE, before candidate 1, not once per
 * iteration, so `best-of-n.ts`'s `buildRound1Substitute` sequences the two as separate elements
 * ahead of this loop rather than folding the persist into the loop's per-iteration body.
 */
export const bestOfNCandidateLoopLeaf = (
  deps: ImplementDeps,
  opts: BestOfNGenEvalOpts,
  taskId: TaskId
): Element<ImplementCtx> =>
  loop<ImplementCtx>(`best-of-n-candidates-${String(taskId)}`, bestOfNOneCandidateLeaf(deps, opts, taskId), {
    maxIterations: MAX_BEST_OF_N_CANDIDATES,
    shouldContinue: (ctx, i) => i <= Math.min(ctx.currentTask?.bestOfNGrantedCandidates ?? 0, MAX_BEST_OF_N_CANDIDATES),
  });
