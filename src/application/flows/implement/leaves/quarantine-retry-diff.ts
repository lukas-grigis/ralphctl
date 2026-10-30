import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import type { WriteFile } from '@src/business/io/write-file.ts';
import { gitStashPatch, gitStashPush } from '@src/integration/io/git-stash.ts';
import type { GitRunner } from '@src/integration/io/git-runner.ts';
import {
  REJECTED_DIFF_PATCH_MAX_BYTES,
  rejectedDiffPatchPath,
} from '@src/application/flows/implement/leaves/verify-log.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';

/**
 * Quarantine the rejected working-tree diff of an attempt that earned a RETRY despite a red
 * post-task-verify — the composed case where finalize-gen-eval granted `shouldFailAttempt`
 * (escalate / nudge / malformed same-model retry) AND a later red post-verify stamped
 * `lastBlockReason` on the same attempt.
 *
 * Settle's precedence lets the retry win (remedies before surrender), and the commit guard —
 * keyed on the block reason — has already skipped committing the red work. Without this leaf the
 * rejected diff would stay in the tree and the RETRIED attempt's own pre-task-verify would go red
 * on it, hard-blocking the very retry the policy just granted. Stashing the diff lets the next
 * attempt start from the last good commit; the evaluator critique and the `verify-failed`
 * AttemptWarning carry the learnings forward, and a copy of the set-aside diff is saved as a
 * patch under {@link rejectedDiffPatchPath} that the retry's `<retry_feedback>` offers as an
 * optional, unverified lead — never auto-applied. The stash entry itself stays recoverable via
 * `git stash list`.
 *
 * Guarded at the call site on BOTH flags being set (`lastShouldFailAttempt && lastBlockReason`),
 * and placed BEFORE settle-attempt because settle's output projection clears both flags. On the
 * ordinary retry path (green verify → work committed) the tree is already clean and
 * `gitStashPush` no-ops, so a broad guard costs nothing. Best-effort like the blocked-diff
 * quarantine: the retry is already granted, so a failed stash logs and proceeds — the retried
 * attempt's pre-verify will then surface the still-red tree explicitly rather than silently.
 */
export interface QuarantineRetryDiffLeafDeps {
  readonly gitRunner: GitRunner;
  readonly logger: Logger;
  readonly writeFile: WriteFile;
}

export interface QuarantineRetryDiffLeafOpts {
  /** The tree the just-failed attempt ran (and dirtied) against. */
  readonly cwd: AbsolutePath;
  readonly sprintDir: AbsolutePath;
}

interface RetryQuarantineInput {
  readonly sprintId: SprintId;
  /** 1-based number of the running attempt being settled — disambiguates stash entries. */
  readonly attemptN: number;
}

/**
 * Deterministic stash message for one rejected retry diff. Includes the attempt number so
 * successive red retries of the same task produce distinguishable `git stash list` entries.
 */
export const retryStashMessage = (sprintId: SprintId, taskId: TaskId, attemptN: number): string =>
  `ralphctl/${String(sprintId)}/${String(taskId)}/attempt-${String(attemptN)}-rejected-diff`;

/**
 * Best-effort copy of the just-stashed diff to the patch file the retry prompt names. Any
 * failure warns and skips the file; an oversize patch is skipped, not truncated, because a
 * truncated patch cannot apply.
 */
const saveRejectedDiffPatch = async (
  deps: QuarantineRetryDiffLeafDeps,
  opts: QuarantineRetryDiffLeafOpts,
  taskId: TaskId,
  attemptN: number,
  message: string,
  log: Logger
): Promise<void> => {
  const ctx = { taskId: String(taskId), stashMessage: message };
  const shown = await gitStashPatch(deps.gitRunner, opts.cwd, message);
  if (!shown.ok) {
    log.warn('could not read the set-aside diff — no patch file for the retry', { ...ctx, error: shown.error.message });
    return;
  }
  if (shown.value === undefined || shown.value.patch.length === 0) return;
  const bytes = Buffer.byteLength(shown.value.patch, 'utf8');
  if (bytes > REJECTED_DIFF_PATCH_MAX_BYTES) {
    log.warn('set-aside diff too large — no patch file for the retry', { ...ctx, bytes });
    return;
  }
  const path = rejectedDiffPatchPath(opts.sprintDir, taskId, attemptN);
  if (!path.ok) {
    log.warn('could not resolve the patch path — no patch file for the retry', { ...ctx, error: path.error.message });
    return;
  }
  const wrote = await deps.writeFile(path.value, shown.value.patch);
  if (!wrote.ok) {
    log.warn('could not write the set-aside patch', { ...ctx, path: String(path.value), error: wrote.error.message });
    return;
  }
  if (shown.value.partial) {
    log.info('git rejected --include-untracked — the patch omits untracked files', {
      ...ctx,
      path: String(path.value),
    });
  }
};

export const quarantineRetryDiffLeaf = (
  deps: QuarantineRetryDiffLeafDeps,
  opts: QuarantineRetryDiffLeafOpts,
  taskId: TaskId
): Element<ImplementCtx> =>
  leaf<ImplementCtx, RetryQuarantineInput, undefined>(`quarantine-retry-diff-${String(taskId)}`, {
    useCase: {
      execute: async (input): Promise<Result<undefined, DomainError>> => {
        const log = deps.logger.named('task.quarantine-retry-diff');
        const message = retryStashMessage(input.sprintId, taskId, input.attemptN);
        const stashed = await gitStashPush(deps.gitRunner, opts.cwd, message);
        if (!stashed.ok) {
          log.warn('retry-diff stash failed — the retried attempt will see the red tree', {
            taskId: String(taskId),
            cwd: String(opts.cwd),
            error: stashed.error.message,
          });
          return Result.ok(undefined);
        }
        if (stashed.value.stashed) {
          log.info('rejected red diff quarantined before retry', {
            taskId: String(taskId),
            stashMessage: message,
          });
          await saveRejectedDiffPatch(deps, opts, taskId, input.attemptN, message, log);
        }
        return Result.ok(undefined);
      },
    },
    input: (ctx): RetryQuarantineInput => ({
      sprintId: ctx.sprintId,
      attemptN: ctx.currentTask?.attempts.length ?? 0,
    }),
    output: (ctx) => ctx,
    label: 'Stash retry diff',
    internal: true,
  });

/**
 * Synchronous guard predicate for the retry-diff quarantine: the composed case only — a granted
 * retry (`lastShouldFailAttempt`) whose attempt ALSO carries a block reason (in practice a red
 * post-task-verify; finalize never sets both itself). Pure; `AbortError` cannot arise here.
 */
export const isRedVerifyRetry = (ctx: ImplementCtx): boolean =>
  ctx.lastShouldFailAttempt === true && ctx.lastBlockReason !== undefined;
