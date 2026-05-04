/**
 * `createFeedbackFlow` — chain definition for one round of the
 * post-execute feedback loop.
 *
 * Steps (happy path):
 *
 *   load-sprint → assert-active → load-tasks → render-prompt-to-file →
 *     apply-feedback → record-feedback-iteration
 *
 * The feedback loop iterates per user input — one chain run = one
 * round. The CLI/TUI is responsible for:
 *  - prompting the user for the next feedback string,
 *  - exiting the loop on empty input (the natural terminator).
 *
 * `render-prompt-to-file` writes the FULL feedback prompt (sprint name,
 * branch, completed tasks, free-form feedback text, harness context,
 * signal vocabulary) to `<sprintDir>/contexts/feedback-<iteration>.md`.
 * The downstream `apply-feedback` leaf hands the AI a thin wrapper
 * pointing at that file. Empty feedback short-circuits the leaf so no
 * file is written and no AI session is spawned.
 *
 * SIMPLIFICATION: feedback is a separate chain (its own session) rather
 * than embedded inside `executeFlow`. The brief calls this out — once
 * task execution settles, the CLI/TUI checks outcomes and starts a new
 * `createFeedbackFlow` session if the user wants to provide feedback.
 *
 * Per-repo check fan-out after feedback is not yet implemented — that
 * requires a `forEachItem`-shaped primitive in the kernel (see
 * ARCHITECTURE.md Future Work). The `record-feedback-iteration` leaf
 * records `check-skipped` in the transcript until then.
 */
import { Result } from '@src/domain/result.ts';

import { ApplyFeedbackUseCase } from '@src/business/usecases/feedback/apply-feedback.ts';
import type { Sprint } from '@src/domain/entities/sprint.ts';
import type { Task } from '@src/domain/entities/task.ts';
import type { HarnessSignal } from '@src/domain/signals/harness-signal.ts';
import type { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import type { AbsolutePath as AbsolutePathVO } from '@src/domain/values/absolute-path.ts';
import type { SprintId } from '@src/domain/values/sprint-id.ts';
import type { Element } from '@src/kernel/chain/element.ts';
import { Leaf } from '@src/kernel/chain/leaf.ts';
import { Sequential } from '@src/kernel/chain/sequential.ts';
import type { ChainSharedDeps } from '@src/application/chains/chain-deps.ts';
import { assertActiveLeaf } from '@src/application/chains/leaves/assert-active.ts';
import { loadSprintLeaf } from '@src/application/chains/leaves/load-sprint.ts';
import { loadTasksLeaf } from '@src/application/chains/leaves/load-tasks.ts';
import { renderPromptToFileLeaf } from '@src/application/chains/leaves/render-prompt-to-file.ts';

export interface FeedbackCtx {
  readonly sprintId: SprintId;
  readonly cwd: AbsolutePath;
  readonly feedbackText: string;
  /** 1-indexed round counter, surfaced in `record-feedback-iteration`. */
  readonly iteration: number;
  readonly sprint?: Sprint;
  /**
   * Full task set for the sprint, written by `load-tasks`. The
   * `apply-feedback` leaf filters to `status === 'done'` before passing
   * to the use case so the AI sees a meaningful "completed tasks" list.
   */
  readonly tasks?: readonly Task[];
  readonly signals?: readonly HarnessSignal[];
  /**
   * Resolved feedback prompt file path. Set by `render-prompt-to-file`
   * (skipped when feedback text is empty); consumed by `apply-feedback`.
   */
  readonly promptFilePath?: AbsolutePathVO;
}

export function createFeedbackFlow(
  deps: Pick<
    ChainSharedDeps,
    'sprintRepo' | 'taskRepo' | 'aiSession' | 'prompts' | 'signalParser' | 'logger' | 'signalBus' | 'writeContextFile'
  >
): Element<FeedbackCtx> {
  const useCase = new ApplyFeedbackUseCase(deps.aiSession, deps.signalParser, deps.logger, deps.signalBus);

  const renderPromptStep = renderPromptToFileLeaf<FeedbackCtx>(
    { writeContextFile: deps.writeContextFile },
    {
      flowName: 'feedback',
      identifier: (ctx) => String(ctx.iteration),
      // Empty / whitespace-only feedback is the natural loop terminator —
      // skip the render so we don't write a stub file the AI never sees.
      skip: (ctx) => ctx.feedbackText.trim().length === 0,
      buildPrompt: (ctx) => {
        if (!ctx.sprint) {
          throw new Error('render-prompt-to-file: ctx.sprint must be loaded first');
        }
        const completedTasks = (ctx.tasks ?? []).filter((t) => t.status === 'done');
        return deps.prompts.buildFeedbackPrompt({
          sprint: ctx.sprint,
          feedbackText: ctx.feedbackText,
          completedTasks,
        });
      },
    }
  );

  return new Sequential<FeedbackCtx>('feedback', [
    loadSprintLeaf<FeedbackCtx>({ sprintRepo: deps.sprintRepo }),
    assertActiveLeaf<FeedbackCtx>('feedback'),
    loadTasksLeaf<FeedbackCtx>({ taskRepo: deps.taskRepo }),
    renderPromptStep,
    applyFeedbackLeaf(useCase),
    recordFeedbackIterationLeaf(deps.logger),
  ]);
}

function applyFeedbackLeaf(useCase: ApplyFeedbackUseCase): Element<FeedbackCtx> {
  return new Leaf<
    FeedbackCtx,
    {
      readonly sprint: Sprint;
      readonly sprintId: SprintId;
      readonly iteration: number;
      readonly cwd: AbsolutePath;
      readonly feedbackText: string;
      readonly promptFilePath?: AbsolutePathVO;
    },
    readonly HarnessSignal[]
  >('apply-feedback', {
    useCase: {
      async execute(input) {
        // Empty feedback text short-circuits — the upstream
        // `render-prompt-to-file` leaf skipped the write (no file on
        // disk), so there's no prompt for the AI to read. The chain
        // still walks (record-feedback-iteration / check leaf still
        // emit trace entries) for honesty.
        if (input.feedbackText.trim().length === 0) {
          return Result.ok([] as readonly HarnessSignal[]);
        }
        if (input.promptFilePath === undefined) {
          return Result.error({
            code: 'invalid-state',
            message: 'apply-feedback: promptFilePath is missing — render-prompt-to-file must run first',
          });
        }
        // Per-iteration session.md audit path — feedback has no per-unit
        // folder layout (feedback-folder builder isn't a thing yet), so
        // we derive a stable path under the sprint dir keyed on the
        // 1-indexed iteration counter the launcher passes in. This
        // mirrors the user's mental model of "round N" without needing
        // a second source of truth for the counter.
        const { resolveStoragePaths } = await import('@src/integration/persistence/storage-paths.ts');
        const { join } = await import('node:path');
        const sprintDir = resolveStoragePaths().sprintDir(input.sprintId);
        const { AbsolutePath: APV } = await import('@src/domain/values/absolute-path.ts');
        const sessionMdPath = APV.trustString(join(sprintDir, 'feedback', `session-${String(input.iteration)}.md`));
        const result = await useCase.execute({
          sprint: input.sprint,
          promptFilePath: String(input.promptFilePath),
          cwd: input.cwd,
          sessionMdPath,
        });
        if (!result.ok) return Result.error(result.error);
        return Result.ok(result.value.signals);
      },
    },
    input: (ctx) => {
      if (!ctx.sprint) throw new Error('apply-feedback: ctx.sprint must be loaded');
      return {
        sprint: ctx.sprint,
        sprintId: ctx.sprintId,
        iteration: ctx.iteration,
        cwd: ctx.cwd,
        feedbackText: ctx.feedbackText,
        ...(ctx.promptFilePath !== undefined ? { promptFilePath: ctx.promptFilePath } : {}),
      };
    },
    output: (ctx, signals) => ({ ...ctx, signals }),
  });
}

function recordFeedbackIterationLeaf(logger: ChainSharedDeps['logger']): Element<FeedbackCtx> {
  return new Leaf<
    FeedbackCtx,
    {
      readonly sprintId: SprintId;
      readonly iteration: number;
      readonly feedbackText: string;
    },
    void
  >('record-feedback-iteration', {
    useCase: {
      async execute(input) {
        logger.info('feedback iteration recorded', {
          sprintId: input.sprintId,
          iteration: input.iteration,
        });
        // Best-effort append to <sprintDir>/feedback.md so the user has a
        // durable transcript of feedback rounds.
        if (input.feedbackText.trim().length > 0) {
          try {
            const { resolveStoragePaths } = await import('@src/integration/persistence/storage-paths.ts');
            const { mkdir, appendFile } = await import('node:fs/promises');
            const { dirname } = await import('node:path');
            const path = resolveStoragePaths().feedbackFile(input.sprintId);
            const stamp = new Date().toISOString();
            const block = `\n## Round ${String(input.iteration)} — ${stamp}\n\n**Outcome:** check-skipped\n\n${input.feedbackText.trim()}\n`;
            await mkdir(dirname(path), { recursive: true });
            await appendFile(path, block, 'utf-8');
          } catch (err) {
            logger.warn('feedback: failed to append to feedback.md', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        return Result.ok(undefined);
      },
    },
    input: (ctx) => ({
      sprintId: ctx.sprintId,
      iteration: ctx.iteration,
      feedbackText: ctx.feedbackText,
    }),
    output: (ctx) => ctx,
  });
}
