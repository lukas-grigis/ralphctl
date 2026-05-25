import { Result } from '@src/domain/result.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import type { Element, ElementResult } from '@src/application/chain/element.ts';
import type { TraceEntry } from '@src/application/chain/trace.ts';
import { createImplementFlow, type RepoExecConfig } from '@src/application/flows/implement/flow.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import type { ImplementDeps } from '@src/application/flows/implement/deps.ts';
import { createReviewFlow } from '@src/application/flows/review/flow.ts';
import type { ReviewCtx } from '@src/application/flows/review/ctx.ts';
import type { ReviewDeps } from '@src/application/flows/review/deps.ts';

/**
 * Top-level "run" chain — composes the implement + review flows behind one entry point.
 *
 *   run = implement → (review unless --no-review)
 *
 * Each sub-flow has its own ctx (`ImplementCtx` vs `ReviewCtx`); the composer thus owns the
 * ctx-to-ctx handoff explicitly. Implement runs first; if it succeeds and `noReview` is
 * false, review runs second. The combined chain reports a single linear trace.
 *
 * Same-process repo lock: each sub-flow acquires the repo lock independently. There's a tiny
 * window between implement releasing and review acquiring where another process could sneak
 * in — accepted trade-off vs. coupling the two chains' lifecycles.
 *
 * The composer uses a low-level `Element` rather than `sequential` because the two children
 * have different ctx types — `sequential` requires a uniform ctx.
 */

export interface CreateRunFlowOpts {
  readonly sprintId: SprintId;
  readonly todoTasks: readonly Task[];
  /** Repositories keyed by id — see {@link createImplementFlow} for the multi-repo contract. */
  readonly repositories: ReadonlyMap<RepositoryId, RepoExecConfig>;
  /**
   * Parent dir for the review chain's per-round AI session forensics — `<sprintDir>/review/`.
   * The review chain materialises `round-<N>/` subfolders here.
   */
  readonly reviewRoot: AbsolutePath;
  /**
   * Single repo working tree the review chain commits / runs verify in. Distinct from the AI
   * session's cwd. Picks the first sprint-affected repo. Multi-repo commit / verify for
   * review is out of scope.
   */
  readonly commitCwd: AbsolutePath;
  /** Sprint-affected repos (absolute paths) — mounted into the review AI session. */
  readonly additionalRoots: readonly AbsolutePath[];
  /** Pre-rendered `{{REPOSITORIES}}` block for the apply-feedback prompt. */
  readonly repositoriesBlock: string;
  readonly progressFile: AbsolutePath;
  readonly sprintDir: AbsolutePath;
  readonly feedbackFile: AbsolutePath;
  readonly model: string;
  /**
   * Provider id used to attribute each gen-eval spawn in its per-round `meta.json` and
   * `role-meta.json` sidecars. The meta-run flow's external composer (the `pnpm dev run`
   * entry point) carries one provider for the whole run; per-role split lives on the primary
   * launcher. Required so attribution never silently degrades to "unknown".
   */
  readonly providerId: string;
  readonly verifyScript?: string;
  /** When true, skip the review chain. Default false (review runs). */
  readonly noReview?: boolean;
}

export interface RunDeps {
  readonly implement: ImplementDeps;
  readonly review: ReviewDeps;
}

export interface RunCtx {
  readonly sprintId: SprintId;
}

export const createRunFlow = (deps: RunDeps, opts: CreateRunFlowOpts): Element<RunCtx> => {
  // The meta-run flow's `opts.model` is a single value — stamp it on both gen-eval roles
  // so an external composer that doesn't know about the per-role split (the `pnpm dev run`
  // entry point) still produces a coherent implement chain. Per-role overrides belong on the
  // primary launcher, not on this meta composer.
  const implementFlow = createImplementFlow(deps.implement, {
    sprintId: opts.sprintId,
    todoTasks: opts.todoTasks,
    repositories: opts.repositories,
    progressFile: opts.progressFile,
    sprintDir: opts.sprintDir,
    generatorProviderId: opts.providerId,
    generatorModel: opts.model,
    evaluatorProviderId: opts.providerId,
    evaluatorModel: opts.model,
  });
  const reviewFlow = createReviewFlow(deps.review, {
    sprintId: opts.sprintId,
    reviewRoot: opts.reviewRoot,
    commitCwd: opts.commitCwd,
    additionalRoots: opts.additionalRoots,
    repositoriesBlock: opts.repositoriesBlock,
    feedbackFile: opts.feedbackFile,
    progressFile: opts.progressFile,
    ...(opts.verifyScript !== undefined ? { verifyScript: opts.verifyScript } : {}),
  });

  return {
    name: 'run',
    async execute(ctx, signal, onTrace): Promise<ElementResult<RunCtx>> {
      const start = performance.now();
      const implementResult = await implementFlow.execute(
        { sprintId: ctx.sprintId } satisfies ImplementCtx,
        signal,
        onTrace
      );
      if (!implementResult.ok) {
        const entry: TraceEntry = {
          elementName: 'run',
          status: 'failed',
          durationMs: performance.now() - start,
          error: implementResult.error.error,
        };
        onTrace?.(entry);
        return Result.error({
          error: implementResult.error.error,
          trace: [...implementResult.error.trace, entry],
        });
      }

      if (opts.noReview === true) {
        const entry: TraceEntry = {
          elementName: 'run',
          status: 'completed',
          durationMs: performance.now() - start,
        };
        onTrace?.(entry);
        return Result.ok({
          ctx,
          trace: [...implementResult.value.trace, entry],
        });
      }

      const reviewResult = await reviewFlow.execute({ sprintId: ctx.sprintId } satisfies ReviewCtx, signal, onTrace);
      const entry: TraceEntry = {
        elementName: 'run',
        status: reviewResult.ok ? 'completed' : 'failed',
        durationMs: performance.now() - start,
        ...(reviewResult.ok ? {} : { error: reviewResult.error.error }),
      };
      onTrace?.(entry);
      if (!reviewResult.ok) {
        return Result.error({
          error: reviewResult.error.error,
          trace: [...implementResult.value.trace, ...reviewResult.error.trace, entry],
        });
      }
      return Result.ok({
        ctx,
        trace: [...implementResult.value.trace, ...reviewResult.value.trace, entry],
      });
    },
  };
};
