/**
 * `createFeedbackFlow` — chain definition for one round of the
 * post-execute feedback loop.
 *
 * Steps (happy path):
 *
 *   load-sprint → apply-feedback → check-scripts-feedback →
 *     record-feedback-iteration
 *
 * The feedback loop iterates per user input — one chain run = one
 * round. The CLI/TUI is responsible for:
 *  - prompting the user for the next feedback string,
 *  - exiting the loop on empty input,
 *  - capping iterations via `MAX_FEEDBACK_ITERATIONS`.
 *
 * SIMPLIFICATION: feedback is a separate chain (its own session) rather
 * than embedded inside `executeFlow`. The brief calls this out — once
 * task execution settles, the CLI/TUI checks outcomes and starts a new
 * `createFeedbackFlow` session if the user wants to provide feedback.
 *
 * The `check-scripts-feedback` leaf is a placeholder right now: real
 * post-feedback check execution requires per-repo fan-out which needs
 * `forEachItem` (or similar) in the kernel. Today the leaf records that
 * checks should run; the chain layer can extend this once the primitive
 * exists.
 */
import { Result } from 'typescript-result';

import { ApplyFeedbackUseCase } from '../../../business/usecases/feedback/apply-feedback.ts';
import type { Sprint } from '../../../domain/entities/sprint.ts';
import type { HarnessSignal } from '../../../domain/signals/harness-signal.ts';
import type { AbsolutePath } from '../../../domain/values/absolute-path.ts';
import type { SprintId } from '../../../domain/values/sprint-id.ts';
import type { Element } from '../../../kernel/chain/element.ts';
import { Leaf } from '../../../kernel/chain/leaf.ts';
import { Sequential } from '../../../kernel/chain/sequential.ts';
import type { ChainSharedDeps } from '../chain-deps.ts';
import { loadSprintLeaf } from '../leaves/load-sprint.ts';

export interface FeedbackCtx {
  readonly sprintId: SprintId;
  readonly cwd: AbsolutePath;
  readonly feedbackText: string;
  /** 1-indexed round counter, surfaced in `record-feedback-iteration`. */
  readonly iteration: number;
  readonly sprint?: Sprint;
  readonly signals?: readonly HarnessSignal[];
  readonly checkPassed?: boolean;
}

export interface CreateFeedbackFlowOpts {
  readonly sprintId: SprintId;
  readonly cwd: AbsolutePath;
}

export function createFeedbackFlow(
  deps: Pick<ChainSharedDeps, 'sprintRepo' | 'aiSession' | 'prompts' | 'signalParser' | 'logger'>,
  _opts: CreateFeedbackFlowOpts
): Element<FeedbackCtx> {
  void _opts;
  const useCase = new ApplyFeedbackUseCase(deps.aiSession, deps.prompts, deps.signalParser, deps.logger);

  return new Sequential<FeedbackCtx>('feedback', [
    loadSprintLeaf<FeedbackCtx>({ sprintRepo: deps.sprintRepo }),
    applyFeedbackLeaf(useCase),
    checkScriptsFeedbackLeaf(),
    recordFeedbackIterationLeaf(deps.logger),
  ]);
}

function applyFeedbackLeaf(useCase: ApplyFeedbackUseCase): Element<FeedbackCtx> {
  return new Leaf<
    FeedbackCtx,
    { readonly sprint: Sprint; readonly cwd: AbsolutePath; readonly feedbackText: string },
    readonly HarnessSignal[]
  >('apply-feedback', {
    useCase: {
      async execute(input) {
        const result = await useCase.execute({
          sprint: input.sprint,
          feedbackText: input.feedbackText,
          cwd: input.cwd,
        });
        if (!result.ok) return Result.error(result.error);
        return Result.ok(result.value.signals);
      },
    },
    input: (ctx) => {
      if (!ctx.sprint) throw new Error('apply-feedback: ctx.sprint must be loaded');
      return { sprint: ctx.sprint, cwd: ctx.cwd, feedbackText: ctx.feedbackText };
    },
    output: (ctx, signals) => ({ ...ctx, signals }),
  });
}

/**
 * Placeholder leaf for post-feedback check execution. Today: marks
 * `checkPassed: true` so downstream callers can decide whether to
 * continue. A future revision will fan out per-repo runs once the
 * kernel grows the matching primitive — at which point this leaf
 * becomes a Sequential of per-repo check leaves.
 */
function checkScriptsFeedbackLeaf(): Element<FeedbackCtx> {
  return new Leaf<FeedbackCtx, Record<string, never>, void>('check-scripts-feedback', {
    useCase: {
      async execute() {
        return Promise.resolve(Result.ok(undefined));
      },
    },
    input: () => ({}),
    output: (ctx) => ({ ...ctx, checkPassed: true }),
  });
}

function recordFeedbackIterationLeaf(logger: ChainSharedDeps['logger']): Element<FeedbackCtx> {
  return new Leaf<FeedbackCtx, { readonly sprintId: SprintId; readonly iteration: number }, void>(
    'record-feedback-iteration',
    {
      useCase: {
        async execute(input) {
          logger.info('feedback iteration recorded', {
            sprintId: input.sprintId,
            iteration: input.iteration,
          });
          return Promise.resolve(Result.ok(undefined));
        },
      },
      input: (ctx) => ({ sprintId: ctx.sprintId, iteration: ctx.iteration }),
      output: (ctx) => ctx,
    }
  );
}
