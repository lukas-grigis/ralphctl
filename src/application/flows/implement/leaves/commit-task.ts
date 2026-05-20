import { commitTaskUseCase, type CommitTaskProps } from '@src/business/task/commit-task.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { UpdateTask } from '@src/domain/repository/task/update-task.ts';
import { type InProgressTask, type Task } from '@src/domain/entity/task.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import { type AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import { COMMIT_MESSAGE_MAX_BYTES, gitCommitWithMessage } from '@src/integration/io/git-operations.ts';
import type { GitRunner } from '@src/integration/io/git-runner.ts';
import { renderTicketRefsSection } from '@src/integration/ai/prompts/_engine/renderers/task.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';

export type CommitMessageFactory = (input: { readonly task: Task }) => string;

export interface CommitTaskLeafDeps {
  readonly gitRunner: GitRunner;
  readonly taskRepo: UpdateTask;
  readonly clock: () => IsoTimestamp;
  readonly logger: Logger;
}

// Hard cap on the full commit message imported from the validator in `git-operations.ts` so
// the factories below cannot drift from the last-line-of-defence check. Per-task commits are
// signal for the harness, not prose — the AI's descriptive write-up lives in `progress.md`,
// not in git history. The cap leaves room for a conventional subject, a short WHY paragraph,
// and the per-ticket `Closes …` trailer the harness appends from `Task.externalRefs`.
const ELLIPSIS = '...';

/** UTF-8 byte length — `commit-task` argv is bytes-bound, not chars-bound. */
const byteLen = (s: string): number => Buffer.byteLength(s, 'utf8');

/**
 * Truncate `s` so its UTF-8 byte length is ≤ `maxBytes`. When truncation is needed an ASCII
 * ellipsis is appended (counted in the budget). Iterative trim so we never split a multi-byte
 * codepoint mid-sequence.
 */
const clampToBytes = (s: string, maxBytes: number): string => {
  if (byteLen(s) <= maxBytes) return s;
  const budget = Math.max(0, maxBytes - ELLIPSIS.length);
  let out = s;
  while (out.length > 0 && byteLen(out) > budget) out = out.slice(0, -1);
  return `${out}${ELLIPSIS}`;
};

const firstParagraph = (text: string): string => {
  const trimmed = text.trim();
  if (trimmed.length === 0) return '';
  const blankIdx = trimmed.indexOf('\n\n');
  return (blankIdx === -1 ? trimmed : trimmed.slice(0, blankIdx)).trim();
};

/**
 * Assemble `subject` + optional `body` into a conventional `git commit -m` message clamped to
 * `COMMIT_MESSAGE_MAX_BYTES` total. Priority order:
 *   1. Subject always fits — if it alone exceeds the cap, truncate it and drop the body.
 *   2. Otherwise budget the body against `cap - byteLen(subject + "\n\n")`. If that budget
 *      is non-positive (subject already uses the whole cap), drop the body entirely.
 *   3. Truncate body to the budget. Empty / missing body → subject-only.
 *
 * This guarantees the returned string passes the validator in `git-operations.ts`; callers
 * never need to re-check.
 */
const assembleCommitMessage = (subject: string, body: string | undefined): string => {
  const cap = COMMIT_MESSAGE_MAX_BYTES;
  const subjectFit = clampToBytes(subject, cap);
  if (body === undefined || body.length === 0) return subjectFit;
  const overhead = byteLen(subjectFit) + 2; // `\n\n`
  if (overhead >= cap) return subjectFit;
  const bodyFit = clampToBytes(body, cap - overhead);
  if (bodyFit.length === 0 || bodyFit === ELLIPSIS) return subjectFit;
  return `${subjectFit}\n\n${bodyFit}`;
};

const defaultMessageFactory: CommitMessageFactory = ({ task }): string =>
  assembleCommitMessage(task.name, firstParagraph(task.description ?? ''));

/**
 * Append the deterministic `Closes <ref>` trailer block when the task carries external
 * references. Centralised here (rather than asked of the AI via the prompt) so persisted
 * ticket → commit linkage doesn't depend on model compliance.
 *
 * Layout: existing message + blank line + trailer. If the existing message is already at or
 * near the cap, the message tail is truncated (with the same ellipsis convention used by
 * `clampToBytes`) so the trailer always lands intact at the end. If the trailer alone cannot
 * fit alongside even a 1-byte subject — extreme edge — the original message is returned
 * unchanged; better to ship the message without the trailer than ship a degenerate message.
 */
const appendTrailerToMessage = (message: string, refs: readonly string[] | undefined): string => {
  const trailer = renderTicketRefsSection(refs);
  if (trailer.length === 0) return message;
  const trailerBytes = byteLen(trailer);
  const separatorBytes = 2; // `\n\n`
  const overhead = separatorBytes + trailerBytes;
  if (overhead + 1 > COMMIT_MESSAGE_MAX_BYTES) return message;
  if (byteLen(message) + overhead <= COMMIT_MESSAGE_MAX_BYTES) {
    return `${message}\n\n${trailer}`;
  }
  const innerCap = COMMIT_MESSAGE_MAX_BYTES - overhead;
  const truncated = clampToBytes(message, innerCap);
  return `${truncated}\n\n${trailer}`;
};

export interface CommitTaskLeafOpts {
  readonly cwd: AbsolutePath;
  readonly messageFactory?: CommitMessageFactory;
}

interface CommitInput {
  readonly task: InProgressTask;
  readonly sprintId: SprintId;
  readonly message: string;
}

interface CommitOutput {
  readonly task: InProgressTask;
  readonly sha?: string;
}

/**
 * Chain leaf — wires the GitRunner to a function-shape `gitCommit` dep and delegates to
 * commitTaskUseCase. Business policy (clean tree skip, hook-failure warn, SHA → attempt) lives
 * in `@src/business/task/commit-task.ts`.
 */
export const commitTaskLeaf = (
  deps: CommitTaskLeafDeps,
  opts: CommitTaskLeafOpts,
  taskId: TaskId
): Element<ImplementCtx> => {
  const gitCommit: CommitTaskProps['gitCommit'] = (cwd, message) => gitCommitWithMessage(deps.gitRunner, cwd, message);

  return leaf<ImplementCtx, CommitInput, CommitOutput>(`commit-task-${String(taskId)}`, {
    useCase: {
      execute: async (input) =>
        commitTaskUseCase({
          ...input,
          cwd: opts.cwd,
          gitCommit,
          taskRepo: deps.taskRepo,
          clock: deps.clock,
          logger: deps.logger,
        }),
    },
    input: (ctx) => {
      if (ctx.currentTask === undefined || ctx.currentTask.id !== taskId) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-commit',
          attemptedAction: `commit-task-${String(taskId)}`,
          message: `commit-task-${String(taskId)}: ctx.currentTask missing or mismatched`,
        });
      }
      if (ctx.currentTask.status !== 'in_progress') {
        throw new InvalidStateError({
          entity: 'task',
          currentState: ctx.currentTask.status,
          attemptedAction: `commit-task-${String(taskId)}`,
          message: `commit-task-${String(taskId)}: expected in_progress task`,
        });
      }
      const task = ctx.currentTask;
      // Resolution order:
      //   1. Generator-proposed `<commit-message>` signal from this run's gen-eval loop.
      //      Subject + optional body are joined with the conventional blank-line separator.
      //   2. Caller-supplied `opts.messageFactory` (legacy injection point).
      //   3. Default `task(<short-id>): <name>` factory.
      // After resolution we always append the deterministic `Closes …` trailer when the task
      // carries external refs — the AI no longer sees the refs, so this is the only writer.
      const proposed = ctx.proposedCommitMessage;
      const baseMessage =
        proposed !== undefined
          ? assembleCommitMessage(proposed.subject, proposed.body)
          : (opts.messageFactory ?? defaultMessageFactory)({ task });
      const message = appendTrailerToMessage(baseMessage, task.externalRefs);
      return { task, sprintId: ctx.sprintId, message };
    },
    output: (ctx, out) => ({
      ...ctx,
      currentTask: out.task,
      tasks: (ctx.tasks ?? []).map((t) => (t.id === out.task.id ? (out.task as Task) : t)),
      ...(out.sha !== undefined ? { lastCommitSha: out.sha } : {}),
    }),
  });
};
