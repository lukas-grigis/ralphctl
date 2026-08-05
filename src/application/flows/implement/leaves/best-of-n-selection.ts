import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type { Attribution } from '@src/domain/entity/attempt.ts';
import { recordRunningAttemptVerification } from '@src/domain/entity/task-attempts.ts';
import type { InProgressTask, Task } from '@src/domain/entity/task.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { isFatalChainError } from '@src/domain/value/error/is-fatal-chain-error.ts';
import type { LearningEntry } from '@src/domain/signal.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import type { ImplementDeps } from '@src/application/flows/implement/deps.ts';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import { READ_ONLY } from '@src/integration/ai/providers/_engine/session-permissions.ts';
import type { SessionId } from '@src/integration/ai/providers/_engine/session-id.ts';
import { currentSessionId } from '@src/application/session/session.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import { buildSelectCandidatePrompt } from '@src/integration/ai/prompts/select-candidate/definition.ts';
import { renderContractSectionFor } from '@src/integration/ai/contract/_engine/render-contract-section.ts';
import { validateSignalsFile } from '@src/integration/ai/contract/_engine/validate-signals-file.ts';
import { selectCandidateOutputContract } from '@src/application/flows/implement/leaves/select-candidate.contract.ts';
import { runPathsFor } from '@src/application/flows/_shared/allocate-run-dir.ts';
import { gitStashPop } from '@src/integration/io/git-operations.ts';
import { writeTextAtomic } from '@src/integration/io/fs.ts';
import type {
  BestOfNCandidateRecord,
  BestOfNGenEvalOpts,
} from '@src/application/flows/implement/leaves/best-of-n-candidate.ts';

/**
 * Selection cascade over the candidates a best-of-N attempt sampled — the escalation-map ablation
 * order (execution filter, then dedupe, then judge; every stage removed costs 1.8-2.8pp — arXiv
 * 2507.23370, Trae):
 *
 *   1. Discard candidates whose verify attribution is `'regressed'` — the harness's own execution
 *      filter, applied first (the paper's highest-yield stage).
 *   2. Dedupe identical diffs by content hash — two candidates that converged on the same patch
 *      are one candidate for judging purposes.
 *   3. Zero survivors → apply nothing; the attempt proceeds with a clean tree and the evaluator
 *      fails it normally (logged clearly — the once-per-task grant means the next walk tops out).
 *      One survivor → apply it directly, no judge call. Multiple → a pairwise judge tournament
 *      (winner of 1-vs-2 meets 3, and so on — at most n-1 calls), each verdict a one-shot AI
 *      session over the CANDIDATES' compact structured summaries only, never raw diffs (arXiv
 *      2604.16529 — RTV). A judge session that fails to produce a valid signal falls back to the
 *      verification-quality ordering (attribution rank, then fewest changed files) — logged,
 *      never fatal to the attempt.
 *
 * Applying the winner reuses the SAME stash seam `quarantine-retry-diff.ts` /
 * `restore-blocked-diff.ts` already use for capture/restore: `gitStashPop` by the candidate's own
 * `stashMessage`. A losing candidate's stash is never popped — recoverable via `git stash list`,
 * matching every other quarantine in this codebase.
 */

/** Shared logger namespace for every selection-cascade log line. */
const BEST_OF_N_SELECTION_LOGGER = 'implement.best-of-n.selection';

/** Best-to-worst attribution rank for the judge-failure fallback ordering. `'regressed'` never
 * reaches this table — it is filtered out by stage 1 before the fallback can see it. */
const ATTRIBUTION_RANK: Readonly<Record<Attribution, number>> = {
  clean: 0,
  'fixed-baseline': 1,
  'baseline-broken': 2,
  regressed: 3,
};

/** Rank for a candidate whose attribution is unknown (spawn-error / skipped baseline) — between
 * a proven-clean/fixed candidate and a proven-broken one, mirroring `attempt-summary.ts`'s
 * `ATTRIBUTION_SCORE_UNKNOWN` convention. */
const ATTRIBUTION_RANK_UNKNOWN = 1.5;

const attributionRank = (attribution: Attribution | undefined): number =>
  attribution !== undefined ? ATTRIBUTION_RANK[attribution] : ATTRIBUTION_RANK_UNKNOWN;

/** Stage 1 — discard `'regressed'` candidates (the harness's own execution filter). */
const discardRegressed = (candidates: readonly BestOfNCandidateRecord[]): readonly BestOfNCandidateRecord[] =>
  candidates.filter((c) => c.attribution !== 'regressed');

/**
 * Stage 2 — dedupe identical diffs by content hash. A candidate with no diff (`hadDiff: false`,
 * `contentHash` absent) is never deduped against another no-diff candidate — two independently
 * "did nothing" sessions are not the same evidence, so each is kept. First-seen hash wins.
 */
const dedupeByContentHash = (candidates: readonly BestOfNCandidateRecord[]): readonly BestOfNCandidateRecord[] => {
  const seen = new Set<string>();
  const kept: BestOfNCandidateRecord[] = [];
  for (const c of candidates) {
    if (c.contentHash === undefined) {
      kept.push(c);
      continue;
    }
    if (seen.has(c.contentHash)) continue;
    seen.add(c.contentHash);
    kept.push(c);
  }
  return kept;
};

/** Judge-failure fallback ordering — attribution rank, then fewest changed files (a smaller,
 * more targeted diff is preferred when verification evidence alone cannot break the tie). */
const fallbackBetter = (a: BestOfNCandidateRecord, b: BestOfNCandidateRecord): BestOfNCandidateRecord => {
  const rankA = attributionRank(a.attribution);
  const rankB = attributionRank(b.attribution);
  if (rankA !== rankB) return rankA < rankB ? a : b;
  return a.changedFileCount <= b.changedFileCount ? a : b;
};

/**
 * Per-call `AiSession` for one judge spawn — READ_ONLY (no shell, no edits), mirroring every
 * other one-shot review-style flow (readiness / detect-skills / detect-scripts). The prompt
 * itself instructs the judge to compare the two candidate summaries only, never explore the
 * repo (arXiv 2604.16529's setup); READ_ONLY is the closest permission profile this port
 * exposes to "no repository access" — cwd still resolves to the repo (every provider needs
 * SOME cwd + a writable `outputDir` for `signals.json`), but Edit/MultiEdit/Bash are denied.
 */
const buildJudgeSession = (opts: {
  readonly cwd: AbsolutePath;
  readonly prompt: Prompt;
  readonly model: string;
  readonly effort: string | undefined;
  readonly signalsFile: AbsolutePath;
  readonly outputDir: AbsolutePath;
  readonly bodyFile: AbsolutePath;
  readonly abortSignal: AbortSignal | undefined;
}): AiSession => {
  const chainSessionId = currentSessionId();
  return {
    prompt: opts.prompt,
    cwd: opts.cwd,
    model: opts.model,
    permissions: READ_ONLY,
    signalsFile: opts.signalsFile,
    outputDir: opts.outputDir,
    bodyFile: opts.bodyFile,
    ...(chainSessionId !== undefined ? { chainSessionId } : {}),
    ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
    ...(opts.abortSignal !== undefined ? { abortSignal: opts.abortSignal } : {}),
  };
};

/** Build the judge's prompt, spawn the READ_ONLY session, and write its prompt to disk. Returns
 * the judge dir on success; `Result.error` only for a fatal chain error or an I/O failure. */
const spawnJudge = async (
  deps: ImplementDeps,
  opts: BestOfNGenEvalOpts,
  taskId: TaskId,
  workspaceRoot: AbsolutePath,
  task: Task,
  a: BestOfNCandidateRecord,
  b: BestOfNCandidateRecord,
  callIndex: number,
  abortSignal: AbortSignal | undefined
): Promise<Result<AbsolutePath | undefined, DomainError>> => {
  const log = deps.logger.named(BEST_OF_N_SELECTION_LOGGER);
  const judgeDir = AbsolutePath.parse(join(String(workspaceRoot), 'candidates', 'judge', String(callIndex)));
  if (!judgeDir.ok) return Result.error(judgeDir.error);
  const paths = runPathsFor(judgeDir.value);
  if (!paths.ok) return Result.error(paths.error);

  const outputContractSection = renderContractSectionFor(selectCandidateOutputContract, judgeDir.value);
  const prompt = await buildSelectCandidatePrompt(deps.templateLoader, {
    task,
    candidateASummary: a.summary,
    candidateBSummary: b.summary,
    outputContractSection,
  });
  if (!prompt.ok) return Result.error(prompt.error);

  const promptWrote = await writeTextAtomic(String(paths.value.promptFile), String(prompt.value));
  if (!promptWrote.ok) return Result.error(promptWrote.error);

  const session = buildJudgeSession({
    cwd: opts.cwd,
    prompt: prompt.value,
    model: opts.evaluator.model,
    effort: opts.evaluator.effort,
    signalsFile: paths.value.signalsFile,
    outputDir: judgeDir.value,
    bodyFile: paths.value.bodyFile,
    abortSignal,
  });

  const spawn = await deps.evaluatorProvider.generate(session);
  if (!spawn.ok) {
    if (isFatalChainError(spawn.error)) return Result.error(spawn.error);
    log.warn(`best-of-n judge call ${String(callIndex)} spawn failed for task '${String(taskId)}' — falling back`, {
      taskId: String(taskId),
      error: spawn.error.message,
    });
    return Result.ok(undefined);
  }
  return Result.ok(judgeDir.value);
};

/** Validate + interpret the judge's verdict once the spawn has completed. `undefined` on any
 * recoverable failure (invalid signals, non-binary winner) — falls back to the quality ordering. */
const readJudgeVerdict = async (
  deps: ImplementDeps,
  taskId: TaskId,
  judgeDir: AbsolutePath,
  callIndex: number
): Promise<'a' | 'b' | undefined> => {
  const log = deps.logger.named(BEST_OF_N_SELECTION_LOGGER);
  const validated = await validateSignalsFile(judgeDir, selectCandidateOutputContract);
  if (!validated.ok) {
    log.warn(`best-of-n judge call ${String(callIndex)} signals invalid for task '${String(taskId)}' — falling back`, {
      taskId: String(taskId),
      error: validated.error.message,
    });
    return undefined;
  }
  for (const sig of validated.value) deps.publishSignal(sig);

  const verdict = validated.value[0];
  if (verdict === undefined || (verdict.winner !== 1 && verdict.winner !== 2)) {
    log.warn(
      `best-of-n judge call ${String(callIndex)} produced no usable winner for task '${String(taskId)}' — falling back`,
      { taskId: String(taskId), winner: verdict?.winner }
    );
    return undefined;
  }
  return verdict.winner === 1 ? 'a' : 'b';
};

/** One pairwise verdict — `'a' | 'b'` on a valid judge signal, `undefined` on any recoverable
 * failure (fall back to verification-quality ordering), `Result.error` only on a fatal chain error. */
const runOneJudgeCall = async (
  deps: ImplementDeps,
  opts: BestOfNGenEvalOpts,
  taskId: TaskId,
  workspaceRoot: AbsolutePath,
  task: Task,
  a: BestOfNCandidateRecord,
  b: BestOfNCandidateRecord,
  callIndex: number,
  abortSignal: AbortSignal | undefined
): Promise<Result<'a' | 'b' | undefined, DomainError>> => {
  const judgeDir = await spawnJudge(deps, opts, taskId, workspaceRoot, task, a, b, callIndex, abortSignal);
  if (!judgeDir.ok) return Result.error(judgeDir.error);
  if (judgeDir.value === undefined) return Result.ok(undefined);
  return Result.ok(await readJudgeVerdict(deps, taskId, judgeDir.value, callIndex));
};

/**
 * Pairwise tournament: winner of (1 vs 2) meets 3, and so on — exactly `survivors.length - 1`
 * judge calls. A judge failure at any step degrades that ONE comparison to the verification-
 * quality fallback ordering rather than aborting the tournament.
 */
const runJudgeTournament = async (
  deps: ImplementDeps,
  opts: BestOfNGenEvalOpts,
  taskId: TaskId,
  workspaceRoot: AbsolutePath,
  task: Task,
  survivors: readonly BestOfNCandidateRecord[],
  abortSignal: AbortSignal | undefined
): Promise<Result<BestOfNCandidateRecord, DomainError>> => {
  let current = survivors[0];
  if (current === undefined) {
    // Unreachable given the caller only invokes this with >= 2 survivors — defensive only.
    return Result.error(
      new InvalidStateError({
        entity: 'chain',
        currentState: 'best-of-n-selection',
        attemptedAction: `best-of-n-selection-${String(taskId)}`,
        message: 'best-of-n judge tournament called with no candidates',
      })
    );
  }
  for (let i = 1; i < survivors.length; i++) {
    const challenger = survivors[i];
    if (challenger === undefined) continue;
    const verdict = await runOneJudgeCall(deps, opts, taskId, workspaceRoot, task, current, challenger, i, abortSignal);
    if (!verdict.ok) return Result.error(verdict.error);
    current =
      verdict.value === undefined ? fallbackBetter(current, challenger) : verdict.value === 'a' ? current : challenger;
  }
  return Result.ok(current);
};

interface SelectionInput {
  readonly task: InProgressTask;
  readonly workspaceRoot: AbsolutePath;
  readonly candidates: readonly BestOfNCandidateRecord[];
  /**
   * Total candidate-loop iterations attempted this attempt (successful or not) — `ctx.
   * bestOfNSampledCount`, NOT `candidates.length` (successful records only). Feeds the journal
   * summary's "sampled" count so it reflects what the operator actually paid for, including a
   * self-blocked / crashed / invalid-signals slot that contributed no record.
   */
  readonly sampledCount: number;
}

interface SelectionOutput {
  readonly task: InProgressTask;
  readonly proposedCommitMessage?: { readonly subject: string; readonly body?: string };
  readonly capturedSessionId?: SessionId;
  readonly decisionsEmitted: readonly string[];
  readonly changesEmitted: readonly string[];
  readonly learningsEmitted: readonly LearningEntry[];
  readonly notesEmitted: readonly string[];
  /** Best-of-N summary for the journal's `### Continuation state` block — see `ctx.bestOfNSummary`. */
  readonly bestOfNSummary: {
    readonly candidatesSampled: number;
    readonly survivors: number;
    readonly winnerIndex?: number;
  };
}

/** Clear the once-consumed transient handshake — the permanent `bestOfNGranted` marker is left
 * untouched (it is what enforces the once-per-task gate; only the transient N is consumed here). */
const consumeGrant = (task: InProgressTask): InProgressTask => {
  const { bestOfNGrantedCandidates: _drop, ...rest } = task;
  void _drop;
  return rest;
};

/** Stages 1-3 of the cascade: discard regressed, dedupe (done by the caller — see
 * `selectionUseCase`), then pick a winner over the already-filtered `survivors` (direct on 0/1
 * survivors, a judge tournament on 2+). Split out of `selectionUseCase` to keep that function's
 * own complexity to the apply + verification-stamp dispatch. */
const pickWinner = async (
  deps: ImplementDeps,
  opts: BestOfNGenEvalOpts,
  taskId: TaskId,
  task: InProgressTask,
  workspaceRoot: AbsolutePath,
  survivors: readonly BestOfNCandidateRecord[],
  sampled: number,
  signal: AbortSignal | undefined
): Promise<Result<BestOfNCandidateRecord | undefined, DomainError>> => {
  const log = deps.logger.named(BEST_OF_N_SELECTION_LOGGER);
  if (survivors.length === 0) {
    log.warn(
      `best-of-n: zero surviving candidates for task '${String(taskId)}' — proceeding with no diff applied; the evaluator will fail this round normally and the once-per-task grant means the next walk tops out`,
      { taskId: String(taskId), sampled }
    );
    return Result.ok(undefined);
  }
  if (survivors.length === 1) return Result.ok(survivors[0]);
  return runJudgeTournament(deps, opts, taskId, workspaceRoot, task, survivors, signal);
};

/**
 * Apply the winner's stashed diff. FAIL LOUD on a genuine pop failure (`gitStashPop`'s
 * `Result.error` — a merge conflict or another git error): the working tree may now carry
 * conflict markers / a half-applied merge, and letting the attempt continue would hand that tree
 * to the evaluator (and, on a passing verdict, to `commit-task`'s `git add -A`). A pop that
 * simply found no matching stash entry (`{ popped: false }`, `Result.ok`) is the softer "nothing
 * to apply" case — the tree is unchanged, so the attempt degrades to "no diff applied" exactly
 * like the zero-survivors path.
 */
const applyWinner = async (
  deps: ImplementDeps,
  opts: BestOfNGenEvalOpts,
  taskId: TaskId,
  candidatesSampled: number,
  winner: BestOfNCandidateRecord
): Promise<Result<BestOfNCandidateRecord | undefined, DomainError>> => {
  const log = deps.logger.named(BEST_OF_N_SELECTION_LOGGER);
  const applied = await gitStashPop(deps.gitRunner, opts.cwd, winner.stashMessage);
  if (!applied.ok) {
    log.error(
      `best-of-n: applying the winning candidate's diff failed for task '${String(taskId)}' — the working tree may be half-applied or carry conflict markers; failing the attempt rather than letting the evaluator (and a possible commit) see it`,
      { taskId: String(taskId), stashMessage: winner.stashMessage, error: applied.error.message }
    );
    return Result.error(applied.error);
  }
  if (!applied.value.popped) {
    log.warn(
      `best-of-n: the winning candidate's stash entry was not found for task '${String(taskId)}' — proceeding with no diff applied`,
      { taskId: String(taskId), stashMessage: winner.stashMessage }
    );
    return Result.ok(undefined);
  }
  log.info(
    `best-of-n: applied candidate ${String(winner.index)} of ${String(candidatesSampled)} for task '${String(taskId)}'`,
    { taskId: String(taskId), winnerIndex: winner.index }
  );
  return Result.ok(winner);
};

/** Project the (possibly absent) winner + the freshly-verified/grant-cleared task into the
 * leaf's output shape. Split out of `selectionUseCase` purely to keep that function's own
 * complexity budget — the branching already lives in `pickWinner` / `applyWinner`. */
const toSelectionOutput = (
  task: InProgressTask,
  winner: BestOfNCandidateRecord | undefined,
  bestOfNSummary: SelectionOutput['bestOfNSummary']
): SelectionOutput => ({
  task,
  ...(winner?.proposedCommitMessage !== undefined ? { proposedCommitMessage: winner.proposedCommitMessage } : {}),
  ...(winner?.capturedSessionId !== undefined ? { capturedSessionId: winner.capturedSessionId } : {}),
  decisionsEmitted: winner?.decisionsEmitted ?? [],
  changesEmitted: winner?.changesEmitted ?? [],
  learningsEmitted: winner?.learningsEmitted ?? [],
  notesEmitted: winner?.notesEmitted ?? [],
  bestOfNSummary,
});

const selectionUseCase = async (
  deps: ImplementDeps,
  opts: BestOfNGenEvalOpts,
  taskId: TaskId,
  input: SelectionInput,
  signal?: AbortSignal
): Promise<Result<SelectionOutput, DomainError>> => {
  // Stages 1-2 (execution filter, dedupe) run here, once, so both the winner-picking cascade and
  // the journal summary's `survivors` count read the SAME filtered list.
  const survivors = dedupeByContentHash(discardRegressed(input.candidates));
  const picked = await pickWinner(
    deps,
    opts,
    taskId,
    input.task,
    input.workspaceRoot,
    survivors,
    input.sampledCount,
    signal
  );
  if (!picked.ok) return Result.error(picked.error);
  const winnerResult =
    picked.value !== undefined
      ? await applyWinner(deps, opts, taskId, input.candidates.length, picked.value)
      : Result.ok(undefined);
  if (!winnerResult.ok) return Result.error(winnerResult.error);
  const winner = winnerResult.value;

  // The round-1 "generator phase" completed (whether or not a diff landed) without self-blocking
  // or crashing — stamp the structural verification marker every non-blocked generator turn sets
  // so a later `task-verified` evaluator verdict can settle the task, mirroring
  // `runGeneratorTurnUseCase`'s own non-blocked path.
  const verified = recordRunningAttemptVerification(input.task);
  if (!verified.ok) return Result.error(verified.error);
  const task = consumeGrant(verified.value);

  const bestOfNSummary = {
    candidatesSampled: input.sampledCount,
    survivors: survivors.length,
    ...(winner !== undefined ? { winnerIndex: winner.index } : {}),
  };

  return Result.ok(toSelectionOutput(task, winner, bestOfNSummary));
};

const carryArray = <K extends string, T>(
  field: K,
  items: readonly T[],
  prior: readonly T[] | undefined
): Partial<Record<K, readonly T[]>> =>
  items.length > 0 ? ({ [field]: [...(prior ?? []), ...items] } as unknown as Partial<Record<K, readonly T[]>>) : {};

/**
 * Selection leaf — closes out the round-1 candidate substitute: runs the selection cascade over
 * `ctx.bestOfNCandidates`, applies the winner's diff (or none), stamps the running attempt's
 * verification marker, clears the once-consumed grant, merges the winner's narrative signals onto
 * the SAME per-attempt accumulators the real generator leaf feeds — so the evaluator's
 * `<generator_hints>` block (T5) and the progress journal see this round exactly like any other —
 * and stamps `ctx.bestOfNSummary` so the journal's `### Continuation state` block can record that
 * N sessions were spent even though the rest of the attempt looks like a single-turn one.
 * `ctx.bestOfNCandidates` itself is left for `start-attempt` to clear on the next attempt (its
 * `RESET` classification in `sprint-scoped-projection.ts`) — this leaf never re-reads it after use.
 */
export const bestOfNSelectionLeaf = (
  deps: ImplementDeps,
  opts: BestOfNGenEvalOpts,
  taskId: TaskId
): Element<ImplementCtx> =>
  leaf<ImplementCtx, SelectionInput, SelectionOutput>(`best-of-n-selection-${String(taskId)}`, {
    useCase: { execute: (input, signal) => selectionUseCase(deps, opts, taskId, input, signal) },
    input: (ctx) => {
      if (ctx.currentTask === undefined || ctx.currentTask.id !== taskId || ctx.currentTask.status !== 'in_progress') {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-best-of-n-selection',
          attemptedAction: `best-of-n-selection-${String(taskId)}`,
          message: `best-of-n-selection-${String(taskId)}: ctx.currentTask missing, mismatched, or not in_progress`,
        });
      }
      if (ctx.taskWorkspaceRoot === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-best-of-n-selection',
          attemptedAction: `best-of-n-selection-${String(taskId)}`,
          message: `best-of-n-selection-${String(taskId)}: ctx.taskWorkspaceRoot is undefined`,
        });
      }
      const candidates = ctx.bestOfNCandidates ?? [];
      return {
        task: ctx.currentTask,
        workspaceRoot: ctx.taskWorkspaceRoot,
        candidates,
        sampledCount: ctx.bestOfNSampledCount ?? candidates.length,
      };
    },
    output: (ctx, out) => {
      const tasks = (ctx.tasks ?? []).map((t) => (t.id === out.task.id ? (out.task as Task) : t));
      const sessionCarry =
        out.capturedSessionId !== undefined ? { priorGeneratorSessionId: out.capturedSessionId } : {};
      return {
        ...ctx,
        currentTask: out.task,
        tasks,
        genEvalTurn: 1,
        bestOfNSummary: out.bestOfNSummary,
        ...(out.proposedCommitMessage !== undefined ? { proposedCommitMessage: out.proposedCommitMessage } : {}),
        ...sessionCarry,
        ...carryArray('currentAttemptDecisions', out.decisionsEmitted, ctx.currentAttemptDecisions),
        ...carryArray('currentAttemptChanges', out.changesEmitted, ctx.currentAttemptChanges),
        ...carryArray('currentAttemptLearnings', out.learningsEmitted, ctx.currentAttemptLearnings),
        ...carryArray('currentAttemptNotes', out.notesEmitted, ctx.currentAttemptNotes),
      };
    },
  });
