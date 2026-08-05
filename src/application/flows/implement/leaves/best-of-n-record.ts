import type { Attribution, VerifyRunOutcome } from '@src/domain/entity/attempt.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { VerifyGate } from '@src/domain/entity/repository.ts';
import type { AiSignal, LearningEntry } from '@src/domain/signal.ts';
import type { SessionId } from '@src/integration/ai/providers/_engine/session-id.ts';
import type { LogTailReader } from '@src/business/io/log-tail-reader.ts';
import type { RepoExecConfig } from '@src/application/flows/implement/leaves/resolve-repo.ts';
import type { GenEvalLoopRoleConfig } from '@src/application/flows/implement/leaves/_shared/role-spawn.ts';

/**
 * Pure record shapes + composers shared by the candidate loop (`best-of-n-candidate.ts`) and the
 * selection cascade (`best-of-n-selection.ts`) — split out so neither file's line/complexity
 * budget absorbs the other's. No chain / I/O here.
 */

/**
 * Schema ceiling for `settings.harness.bestOfNCandidates` (`domain/entity/settings.ts`:
 * `z.union([z.literal(0), z.number().int().min(2).max(4)])`). The candidate loop is built once
 * per task at this many iterations and a DYNAMIC `shouldContinue` predicate stops it at the
 * task's own granted `n` — see `best-of-n-candidate.ts`'s `bestOfNCandidateLoopLeaf`.
 */
export const MAX_BEST_OF_N_CANDIDATES = 4;

/**
 * Non-flow-owning opts a best-of-N composite needs from the surrounding per-task subchain —
 * deliberately NOT imported from `per-task-subchain.ts` / `attempt-body.ts` (that would create an
 * import cycle back into this module's own callers); structurally compatible with the subset of
 * `PerTaskSubchainOpts` + `RepoExecConfig` those files already hold, so the caller passes its
 * existing objects through without reshaping them.
 */
export interface BestOfNGenEvalOpts {
  readonly cwd: AbsolutePath;
  readonly sprintDir: AbsolutePath;
  readonly progressFile: AbsolutePath;
  readonly verifyScript?: string;
  readonly verifyGates?: readonly VerifyGate[];
  readonly verifyTimeoutMs?: number;
  readonly generator: GenEvalLoopRoleConfig;
  readonly evaluator: GenEvalLoopRoleConfig;
  /**
   * Best-effort reader for the trailing bytes of the harness verify-script logs — same port
   * `GeneratorLeafDeps.logTailReader` accepts (`generator.ts`), threaded here so a best-of-N
   * candidate's prompt can inline the SAME `<pre_verify_results>` / `<retry_feedback>` blocks a
   * normal generator turn gets (see `composeVerifyBlocks` in `generator.ts`). Optional — defaults
   * to the filesystem adapter; tests inject a fake to assert on the composed block's content.
   */
  readonly logTailReader?: LogTailReader;
}

/** Build a {@link BestOfNGenEvalOpts} from the per-task subchain's own `repo` + gen-eval opts. */
export const toBestOfNGenEvalOpts = (
  repo: RepoExecConfig,
  sprintDir: AbsolutePath,
  progressFile: AbsolutePath,
  generator: GenEvalLoopRoleConfig,
  evaluator: GenEvalLoopRoleConfig
): BestOfNGenEvalOpts => ({
  cwd: repo.path,
  sprintDir,
  progressFile,
  ...(repo.verifyScript !== undefined ? { verifyScript: repo.verifyScript } : {}),
  ...(repo.verifyGates !== undefined ? { verifyGates: repo.verifyGates } : {}),
  ...(repo.verifyTimeout !== undefined ? { verifyTimeoutMs: repo.verifyTimeout } : {}),
  generator,
  evaluator,
});

/**
 * One candidate's telemetry — mechanical composition over generator signals, verify
 * outcome/attribution, and diffstat (research: arXiv 2508.21433 — mechanical composition beats
 * LLM summarization on cost at equal-or-better solve rate; the same idiom
 * `business/task/attempt-summary.ts` uses for prior-attempt summaries). A candidate is NOT an
 * `Attempt` — it never settles, is never persisted to `task.attempts` — so this is a sibling
 * record shape, not a reuse of the `Attempt` entity.
 *
 * @public
 */
export interface BestOfNCandidateRecord {
  /** 1-based candidate number within this attempt's sampling round. */
  readonly index: number;
  /** `git stash` subject this candidate's diff (if any) was captured under — the apply seam. */
  readonly stashMessage: string;
  /** False when the session produced no working-tree changes — nothing was stashed. */
  readonly hadDiff: boolean;
  /** Content hash of the working-tree diff (see `computeWorkProductFingerprint`) — dedup key. */
  readonly contentHash?: string;
  /** Count of files the diff touched (tracked + untracked) — fallback tie-break signal. */
  readonly changedFileCount: number;
  /** Harness verify-gate outcome for this candidate's diff, run against the attempt baseline. */
  readonly verifyOutcome: VerifyRunOutcome;
  /** Pre/post attribution — `undefined` when the baseline outcome was unknown (spawn-error/skipped). */
  readonly attribution?: Attribution;
  /** Mechanical, bounded summary text fed to the judge tournament / operator sidecar. */
  readonly summary: string;
  /** Captured session id from this candidate's own spawn, if the provider reported one. */
  readonly capturedSessionId?: SessionId;
  /** This candidate's `commit-message` signal, if it emitted one — carried forward on a win. */
  readonly proposedCommitMessage?: { readonly subject: string; readonly body?: string };
  readonly decisionsEmitted: readonly string[];
  readonly changesEmitted: readonly string[];
  readonly learningsEmitted: readonly LearningEntry[];
  readonly notesEmitted: readonly string[];
}

/**
 * Deterministic stash subject for one candidate's captured diff — mirrors
 * `quarantine-retry-diff.ts`'s `retryStashMessage` shape so `git stash list` reads consistently
 * across every ralphctl-owned stash entry. Never popped for a losing candidate — recoverable via
 * `git stash list` like every other quarantine in this codebase.
 *
 * @public
 */
export const bestOfNStashMessage = (sprintId: SprintId, taskId: TaskId, attemptN: number, index: number): string =>
  `ralphctl/${String(sprintId)}/${String(taskId)}/attempt-${String(attemptN)}-candidate-${String(index)}`;

const SUMMARY_MAX_CHARS = 900;
const DIFFSTAT_MAX_FILES = 12;

/**
 * Compose one candidate's compact structured summary — what was attempted (signals), the
 * verification outcome/attribution, and a diffstat. Bounded mechanical composition (arXiv
 * 2508.21433), fed to the pairwise judge tournament as the compact structured substrate the
 * judge compares (arXiv 2604.16529 — judges compare summaries, never raw diffs/transcripts).
 * Pure. No I/O.
 *
 * @public
 */
export const composeCandidateSummary = (input: {
  readonly hadDiff: boolean;
  readonly changedFiles: readonly string[];
  readonly verifyOutcome: VerifyRunOutcome;
  readonly attribution?: Attribution;
  readonly proposedCommitMessage?: { readonly subject: string; readonly body?: string };
  readonly changesEmitted: readonly string[];
  readonly notesEmitted: readonly string[];
}): string => {
  const lines: string[] = [];
  if (input.proposedCommitMessage !== undefined) lines.push(`Proposed commit: ${input.proposedCommitMessage.subject}`);
  lines.push(
    `Verify outcome: ${input.verifyOutcome}${input.attribution !== undefined ? ` (${input.attribution})` : ''}`
  );
  if (!input.hadDiff) {
    lines.push('Diff: none — the session made no working-tree changes.');
  } else {
    const shown = input.changedFiles.slice(0, DIFFSTAT_MAX_FILES);
    const more = input.changedFiles.length - shown.length;
    lines.push(
      `Diff: ${String(input.changedFiles.length)} file(s) changed — ${shown.join(', ')}${more > 0 ? `, +${String(more)} more` : ''}`
    );
  }
  if (input.changesEmitted.length > 0) lines.push(`Changes claimed: ${input.changesEmitted.slice(-5).join('; ')}`);
  if (input.notesEmitted.length > 0) lines.push(`Notes: ${input.notesEmitted.slice(-3).join('; ')}`);
  const body = lines.join('\n');
  return body.length > SUMMARY_MAX_CHARS ? `${body.slice(0, SUMMARY_MAX_CHARS - 1).trimEnd()}…` : body;
};

/** Find the (at most one expected) signal of a given kind — generic narrow over {@link AiSignal}. */
export const findSignal = <K extends AiSignal['type']>(
  signals: readonly AiSignal[],
  type: K
): Extract<AiSignal, { readonly type: K }> | undefined =>
  signals.find((s): s is Extract<AiSignal, { readonly type: K }> => s.type === type);

/** Fan a generator-shaped session's narrative signals into the record's accumulators. */
/** Narrative-signal accumulators mutated in place by {@link accumulateSignalText} — one bucket
 * per kind, mirroring `generator.ts`'s own per-turn accumulator shape. */
interface SignalTextBuckets {
  readonly decisionsEmitted: string[];
  readonly changesEmitted: string[];
  readonly learningsEmitted: LearningEntry[];
  readonly notesEmitted: string[];
}

/** Route one signal into its matching bucket; a signal kind outside the narrative four is a no-op. */
const accumulateSignalText = (buckets: SignalTextBuckets, sig: AiSignal): void => {
  if (sig.type === 'decision') buckets.decisionsEmitted.push(sig.text);
  else if (sig.type === 'change') buckets.changesEmitted.push(sig.text);
  else if (sig.type === 'learning') {
    buckets.learningsEmitted.push({
      text: sig.text,
      ...(sig.context !== undefined ? { context: sig.context } : {}),
      ...(sig.appliesTo !== undefined ? { appliesTo: sig.appliesTo } : {}),
    });
  } else if (sig.type === 'note') buckets.notesEmitted.push(sig.text);
};

/** Extract the (at most one) `commit-message` signal into the record's plain subject/body shape. */
const extractCommitMessage = (
  signals: readonly AiSignal[]
): { readonly subject: string; readonly body?: string } | undefined => {
  const commitSignal = findSignal(signals, 'commit-message');
  if (commitSignal === undefined) return undefined;
  return commitSignal.body !== undefined
    ? { subject: commitSignal.subject, body: commitSignal.body }
    : { subject: commitSignal.subject };
};

export const signalTexts = (
  signals: readonly AiSignal[]
): Pick<
  BestOfNCandidateRecord,
  'decisionsEmitted' | 'changesEmitted' | 'learningsEmitted' | 'notesEmitted' | 'proposedCommitMessage'
> => {
  const buckets: SignalTextBuckets = {
    decisionsEmitted: [],
    changesEmitted: [],
    learningsEmitted: [],
    notesEmitted: [],
  };
  for (const sig of signals) accumulateSignalText(buckets, sig);
  const proposedCommitMessage = extractCommitMessage(signals);
  return { ...buckets, ...(proposedCommitMessage !== undefined ? { proposedCommitMessage } : {}) };
};
