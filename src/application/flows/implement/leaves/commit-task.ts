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
import { gitCommitWithMessage } from '@src/integration/io/git-operations.ts';
import type { GitRunner } from '@src/integration/io/git-runner.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';

export type CommitMessageFactory = (input: { readonly task: Task }) => string;

export interface CommitTaskLeafDeps {
  readonly gitRunner: GitRunner;
  readonly taskRepo: UpdateTask;
  readonly clock: () => IsoTimestamp;
  readonly logger: Logger;
}

// Hard cap on the full commit message (subject + blank line + body, bytes). Must match
// `COMMIT_MESSAGE_MAX_BYTES` in `git-operations.ts` — the validator there is the
// last-line-of-defense; the factories below should never produce a message that breaches it.
// Per-task commits are signal for the harness, not prose; the AI's descriptive write-up lives
// in `progress.md`, not in git history.
const COMMIT_MESSAGE_MAX_BYTES = 200;
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
      const proposed = ctx.proposedCommitMessage;
      const message =
        proposed !== undefined
          ? assembleCommitMessage(proposed.subject, proposed.body)
          : (opts.messageFactory ?? defaultMessageFactory)({ task });
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
