import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import { type ApplyFeedbackProps, applyFeedbackUseCase } from '@src/business/feedback/apply-feedback.ts';
import { type FeedbackRound, isTerminationRound, parseFeedbackMd } from '@src/business/feedback/md-parser.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';

/**
 * One round of the review loop. Owns the per-round business decisions; the leaf wires the
 * integration ports (editor, file IO, AI provider, git, shell) as function-shape deps so this
 * use case stays integration-agnostic.
 *
 * The decision tree:
 *   1. Open the editor — if it fails the user aborted → exit `aborted`.
 *   2. Read & parse `feedback.md`. If the latest round equals the previous OR is empty,
 *      the user signalled termination → exit `terminated`.
 *   3. Build prompt + call AI via {@link applyFeedbackUseCase}. If the AI emits `<task-blocked>`
 *      → exit `aborted` with the reason in the log.
 *   4. Commit (non-fatal — log warn on failure or empty diff and continue).
 *   5. Run post-task verify (non-fatal).
 *   6. Append a fresh round template so the user has somewhere to write next iteration.
 *   7. Return `continued` with `currentRound` so the next iteration can compare.
 */
export type ReviewRoundExit = 'continued' | 'terminated' | 'aborted';

export interface ReviewRoundCommitResult {
  readonly committed: boolean;
}

export interface ReviewRoundVerifyResult {
  readonly passed: boolean;
  readonly exitCode: number | null;
}

export interface RunReviewRoundProps {
  readonly sprint: Sprint;
  readonly previousRound?: FeedbackRound;

  /** Open the editor on the feedback file; user-cancel → ok=false. */
  readonly openEditor: () => Promise<Result<void, DomainError>>;
  /** Read the current feedback file body. */
  readonly readFeedbackFile: () => Promise<string>;
  /** Read a snippet of the progress file (or a placeholder when absent). */
  readonly readProgressSnippet: () => Promise<string>;
  /** Build the apply-feedback AI prompt + call the provider; returns the parsed harness signals. */
  readonly callApplyFeedback: ApplyFeedbackProps['callApply'];
  /** Render the per-round commit message body. */
  readonly buildPrompt: (params: {
    readonly sprintContext: string;
    readonly feedbackLog: string;
    readonly latestRound: string;
    readonly progress: string;
  }) => Promise<Result<unknown, DomainError>>;
  /** Commit the round's changes (clean tree → ok with `committed=false`). */
  readonly commitRound: (round: FeedbackRound) => Promise<Result<ReviewRoundCommitResult, DomainError>>;
  /** Run the project's post-task verify (skipped when no script configured). Non-fatal. */
  readonly verifyRound?: () => Promise<Result<ReviewRoundVerifyResult, DomainError>>;
  /** Append the next empty round template so the user has somewhere to type. */
  readonly appendNextRound: (nextIndex: number) => Promise<Result<void, StorageError>>;

  readonly logger: Logger;
}

export interface RunReviewRoundOutput {
  readonly exit: ReviewRoundExit;
  /** Latest parsed round; the loop threads it back as `previousRound` next iteration. */
  readonly currentRound?: FeedbackRound;
  /** True when this round produced a commit (used by callers to bump `roundsApplied`). */
  readonly applied: boolean;
}

const COMMIT_BODY_SNIPPET_LEN = 60;

const renderCommitMessage = (round: FeedbackRound): string => {
  const firstLine = round.body.split('\n')[0]?.trim() ?? '';
  const snippet =
    firstLine.length > COMMIT_BODY_SNIPPET_LEN ? `${firstLine.slice(0, COMMIT_BODY_SNIPPET_LEN - 3)}...` : firstLine;
  return `feedback(round-${String(round.index)}): ${snippet}`;
};

const renderFeedbackLog = (rounds: readonly FeedbackRound[]): string => {
  if (rounds.length === 0) return '_no prior rounds_';
  return rounds.map((r) => `### Round ${String(r.index)}\n\n${r.body || '_(empty)_'}`).join('\n\n');
};

const renderSprintContext = (sprint: Sprint): string => {
  const ticketCount = sprint.tickets.length;
  return [
    `**Sprint:** ${sprint.name} (\`${String(sprint.slug)}\`)`,
    `**Status:** ${sprint.status}`,
    `**Tickets:** ${String(ticketCount)}`,
  ].join('\n');
};

export const runReviewRoundUseCase = async (
  props: RunReviewRoundProps
): Promise<Result<RunReviewRoundOutput, DomainError>> => {
  const log = props.logger.named('feedback.review-round');

  const editorResult = await props.openEditor();
  if (!editorResult.ok) {
    log.warn(`editor aborted — ${editorResult.error.message}`);
    return Result.ok({ exit: 'aborted', applied: false });
  }

  const content = await props.readFeedbackFile();
  const rounds = parseFeedbackMd(content);
  const current = rounds.at(-1);
  if (current === undefined) {
    log.info('feedback file emptied — terminating');
    return Result.ok({ exit: 'terminated', applied: false });
  }
  if (isTerminationRound(current, props.previousRound)) {
    log.info(`terminated at round ${String(current.index)}`, { round: current.index });
    return Result.ok({ exit: 'terminated', applied: false });
  }

  const history = rounds.slice(0, -1);
  const promptResult = await props.buildPrompt({
    sprintContext: renderSprintContext(props.sprint),
    feedbackLog: renderFeedbackLog(history),
    latestRound: current.body,
    progress: await props.readProgressSnippet(),
  });
  if (!promptResult.ok) return Result.error(promptResult.error);

  const applied = await applyFeedbackUseCase({
    callApply: props.callApplyFeedback,
    logger: props.logger,
  });
  if (!applied.ok) return Result.error(applied.error);

  if (applied.value.blockedReason !== undefined) {
    log.warn(`AI emitted <task-blocked> in round ${String(current.index)} — ${applied.value.blockedReason}`, {
      round: current.index,
      blockedReason: applied.value.blockedReason,
    });
    return Result.ok({ exit: 'aborted', currentRound: current, applied: false });
  }

  const commit = await props.commitRound(current);
  if (!commit.ok) {
    log.warn(`commit failed for round ${String(current.index)} — ${commit.error.message}`, { round: current.index });
  } else if (!commit.value.committed) {
    log.info(`round ${String(current.index)} produced no diffs — nothing to commit`, { round: current.index });
  }
  void renderCommitMessage; // exposed via deps closure; keep helper colocated for caller reuse.

  if (props.verifyRound !== undefined) {
    const verify = await props.verifyRound();
    if (!verify.ok) {
      log.warn(`verify spawn failed — ${verify.error.message}`, { round: current.index });
    } else if (!verify.value.passed) {
      log.warn(
        `verify failed (exit=${String(verify.value.exitCode ?? 'null')}) after round ${String(current.index)} — surfaced as warning, loop continues`,
        { round: current.index, exitCode: verify.value.exitCode }
      );
    }
  }

  const appended = await props.appendNextRound(current.index + 1);
  if (!appended.ok) return Result.error(appended.error);

  return Result.ok({ exit: 'continued', currentRound: current, applied: true });
};

export { renderCommitMessage as renderReviewCommitMessage };
