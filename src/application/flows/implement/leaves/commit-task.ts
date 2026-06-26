import { type CommitTaskProps, commitTaskUseCase } from '@src/business/task/commit-task.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { UpdateTask } from '@src/domain/repository/task/update-task.ts';
import { type InProgressTask, type Task } from '@src/domain/entity/task.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import { type AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import { gitCommitWithMessage } from '@src/integration/io/git-operations.ts';
import type { GitRunner } from '@src/integration/io/git-runner.ts';
import { renderTicketRefsSubjectSuffix } from '@src/integration/ai/prompts/_engine/renderers/task.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';

export type CommitMessageFactory = (input: { readonly task: Task }) => string;

export interface CommitTaskLeafDeps {
  readonly gitRunner: GitRunner;
  readonly taskRepo: UpdateTask;
  readonly logger: Logger;
}

// Audit-[03] + audit-[09]: commit messages are AI signal bodies — no caps, no truncation.
// `git commit -m <msg>` passes via argv with ARG_MAX headroom in the hundreds of KB; git
// itself has no length limit. Subject + body land verbatim from the validated
// `commit-message` signal; when the task carries external refs the harness appends them
// as a ` (#123, !456)` suffix on the subject line (conventional-commit shape). Auto-close
// on merge is the PR body's job (see `renderIssueRefs` in create-pr) so no body trailer
// is emitted here.

const firstParagraph = (text: string): string => {
  const trimmed = text.trim();
  if (trimmed.length === 0) return '';
  const blankIdx = trimmed.indexOf('\n\n');
  return (blankIdx === -1 ? trimmed : trimmed.slice(0, blankIdx)).trim();
};

const assembleCommitMessage = (subject: string, body: string | undefined): string => {
  if (body === undefined || body.length === 0) return subject;
  return `${subject}\n\n${body}`;
};

const defaultMessageFactory: CommitMessageFactory = ({ task }): string =>
  assembleCommitMessage(task.name, firstParagraph(task.description ?? ''));

const appendSubjectSuffix = (message: string, refs: readonly string[] | undefined): string => {
  const suffix = renderTicketRefsSubjectSuffix(refs);
  if (suffix.length === 0) return message;
  const newlineIdx = message.indexOf('\n');
  const subject = newlineIdx === -1 ? message : message.slice(0, newlineIdx);
  const rest = newlineIdx === -1 ? '' : message.slice(newlineIdx);
  // Idempotency: a hand-authored subject that already ends with the verbatim suffix is left
  // untouched so re-runs / regenerated messages don't grow `(#123) (#123)`.
  if (subject.endsWith(suffix)) return message;
  return `${subject}${suffix}${rest}`;
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
      // After resolution we append a ` (#123, !456)` suffix to the subject line when the task
      // carries external refs — the AI no longer sees the refs, so this is the only writer.
      // The PR body's `Closes #X` lines (rendered by create-pr's `renderIssueRefs`) handle
      // auto-close on merge; no body trailer is added here.
      const proposed = ctx.proposedCommitMessage;
      const baseMessage =
        proposed !== undefined
          ? assembleCommitMessage(proposed.subject, proposed.body)
          : (opts.messageFactory ?? defaultMessageFactory)({ task });
      const message = appendSubjectSuffix(baseMessage, task.externalRefs);
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
