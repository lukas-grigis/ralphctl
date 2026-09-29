import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { isFatalChainError } from '@src/domain/value/error/is-fatal-chain-error.ts';
import type { ImplementDeps } from '@src/application/flows/implement/deps.ts';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import { READ_ONLY } from '@src/integration/ai/providers/_engine/session-permissions.ts';
import { rootSessionId } from '@src/application/session/session.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import { buildSelectCandidatePrompt } from '@src/integration/ai/prompts/select-candidate/definition.ts';
import { renderContractSectionFor } from '@src/integration/ai/contract/_engine/render-contract-section.ts';
import { validateSignalsFile } from '@src/integration/ai/contract/_engine/validate-signals-file.ts';
import { selectCandidateOutputContract } from '@src/application/flows/implement/leaves/select-candidate.contract.ts';
import { runPathsFor } from '@src/application/flows/_shared/allocate-run-dir.ts';
import { writeTextAtomic } from '@src/integration/io/fs.ts';
import type {
  BestOfNCandidateRecord,
  BestOfNGenEvalOpts,
} from '@src/application/flows/implement/leaves/best-of-n-candidate.ts';

/** Shared logger namespace for every selection-cascade log line. */
const BEST_OF_N_SELECTION_LOGGER = 'implement.best-of-n.selection';

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
  const chainSessionId = rootSessionId();
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
  swapped: boolean,
  abortSignal: AbortSignal | undefined
): Promise<Result<AbsolutePath | undefined, DomainError>> => {
  const log = deps.logger.named(BEST_OF_N_SELECTION_LOGGER);
  const dirName = swapped ? `${String(callIndex)}-swapped` : String(callIndex);
  const judgeDir = AbsolutePath.parse(join(String(workspaceRoot), 'candidates', 'judge', dirName));
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

/** Validate + interpret the judge's verdict once the spawn has completed. `'tie'` when the judge
 * declared the pair indistinguishable (`winner: 0`); `undefined` on any recoverable failure
 * (invalid signals, out-of-range winner) — both fall back to the quality ordering. */
const readJudgeVerdict = async (
  deps: ImplementDeps,
  taskId: TaskId,
  judgeDir: AbsolutePath,
  callIndex: number
): Promise<'a' | 'b' | 'tie' | undefined> => {
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
  if (verdict !== undefined && verdict.winner === 0) return 'tie';
  if (verdict === undefined || (verdict.winner !== 1 && verdict.winner !== 2)) {
    log.warn(
      `best-of-n judge call ${String(callIndex)} produced no usable winner for task '${String(taskId)}' — falling back`,
      { taskId: String(taskId), winner: verdict?.winner }
    );
    return undefined;
  }
  return verdict.winner === 1 ? 'a' : 'b';
};

/** One judge spawn over `(first, second)` in that slot order — `'a'` = first slot, `'b'` = second,
 * `'tie'` = declared indistinguishable, `undefined` = any recoverable failure. `Result.error` only
 * on a fatal chain error. */
const runJudgeOrdering = async (
  deps: ImplementDeps,
  opts: BestOfNGenEvalOpts,
  taskId: TaskId,
  workspaceRoot: AbsolutePath,
  task: Task,
  first: BestOfNCandidateRecord,
  second: BestOfNCandidateRecord,
  callIndex: number,
  swapped: boolean,
  abortSignal: AbortSignal | undefined
): Promise<Result<'a' | 'b' | 'tie' | undefined, DomainError>> => {
  const judgeDir = await spawnJudge(
    deps,
    opts,
    taskId,
    workspaceRoot,
    task,
    first,
    second,
    callIndex,
    swapped,
    abortSignal
  );
  if (!judgeDir.ok) return Result.error(judgeDir.error);
  if (judgeDir.value === undefined) return Result.ok(undefined);
  return Result.ok(await readJudgeVerdict(deps, taskId, judgeDir.value, callIndex));
};

/**
 * One pairwise verdict, position-bias-proof (swap-and-agree, arXiv 2306.05685): the judge runs
 * twice with the candidate order swapped, and a winner stands only when both orderings pick the
 * same candidate. A disagreement or a declared tie is `undefined` — the caller's verification-
 * quality fallback decides — as is any recoverable failure in either run. `Result.error` only on
 * a fatal chain error (`AbortError` included), which short-circuits before the second spawn.
 */
export const runOneJudgeCall = async (
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
  const forward = await runJudgeOrdering(deps, opts, taskId, workspaceRoot, task, a, b, callIndex, false, abortSignal);
  if (!forward.ok) return Result.error(forward.error);
  if (forward.value === undefined || forward.value === 'tie') return Result.ok(undefined);

  const swapped = await runJudgeOrdering(deps, opts, taskId, workspaceRoot, task, b, a, callIndex, true, abortSignal);
  if (!swapped.ok) return Result.error(swapped.error);
  if (swapped.value === undefined || swapped.value === 'tie') return Result.ok(undefined);

  // In the swapped run slot 'a' holds candidate `b` — map it back before comparing.
  const swappedInOriginal = swapped.value === 'a' ? 'b' : 'a';
  if (swappedInOriginal !== forward.value) {
    deps.logger
      .named(BEST_OF_N_SELECTION_LOGGER)
      .info(
        `best-of-n judge call ${String(callIndex)} disagreed with itself under candidate-order swap for task '${String(taskId)}' — treating as a tie`,
        { taskId: String(taskId) }
      );
    return Result.ok(undefined);
  }
  return Result.ok(forward.value);
};
