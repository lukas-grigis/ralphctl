/**
 * `createCreatePrFlow` — chain definition for the post-sprint
 * publish-PR / MR workflow.
 *
 * Steps (happy path):
 *
 *   load-sprint → assert-active → assert-has-branch → derive-pr-content →
 *     create-pull-request → record-pr-url
 *
 * Confirmation lives at the caller boundary (CLI prompts; TUI form view).
 * The chain executes once inputs are committed — keeping it pure
 * orchestration with no inline UX prompts.
 *
 * The use case persists the URL via `SprintRepository.save()` (it's the
 * single hop that touches both the platform CLI and storage). The
 * `record-pr-url` leaf simply mirrors the saved sprint onto the chain
 * context so downstream observers (the execute-view) can pick up the URL
 * without re-reading.
 */
import { Result } from '@src/domain/result.ts';

import type { Sprint } from '@src/domain/entities/sprint.ts';
import type { Task } from '@src/domain/entities/task.ts';
import { InvalidStateError } from '@src/domain/errors/invalid-state-error.ts';
import type { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import type { SprintId } from '@src/domain/values/sprint-id.ts';
import type { Element } from '@src/kernel/chain/element.ts';
import { Leaf } from '@src/kernel/chain/leaf.ts';
import { Sequential } from '@src/kernel/chain/sequential.ts';
import { CreatePullRequestUseCase } from '@src/business/usecases/sprint/create-pull-request.ts';
import type { ChainSharedDeps } from '@src/application/chains/chain-deps.ts';
import { assertActiveLeaf } from '@src/application/chains/leaves/assert-active.ts';
import { loadSprintLeaf } from '@src/application/chains/leaves/load-sprint.ts';
import { derivePrContent } from './derive-pr-content.ts';

export interface CreatePrCtx {
  readonly sprintId: SprintId;
  readonly cwd: AbsolutePath;
  readonly base: string;
  readonly draft: boolean;
  /** Optional override; falls back to `derivePrContent`. */
  readonly title?: string;
  /** Optional override; falls back to `derivePrContent`. */
  readonly body?: string;
  readonly sprint?: Sprint;
  readonly tasks?: readonly Task[];
  readonly resolvedTitle?: string;
  readonly resolvedBody?: string;
  readonly pullRequestUrl?: string;
}

export interface CreatePrFlowOpts {
  readonly sprintId: SprintId;
  readonly cwd: AbsolutePath;
  readonly base: string;
  readonly draft: boolean;
  readonly title?: string;
  readonly body?: string;
  /**
   * Pre-loaded tasks to feed the body deriver. Optional — caller may pass
   * an empty array and the deriver simply omits the `## Tasks` section.
   */
  readonly tasks?: readonly Task[];
}

export function createCreatePrFlow(
  deps: Pick<ChainSharedDeps, 'sprintRepo' | 'external' | 'logger'>,
  opts: CreatePrFlowOpts
): Element<CreatePrCtx> {
  const useCase = new CreatePullRequestUseCase(deps.external, deps.sprintRepo, deps.logger);

  return new Sequential<CreatePrCtx>('create-pr', [
    loadSprintLeaf<CreatePrCtx>({ sprintRepo: deps.sprintRepo }),
    assertActiveLeaf<CreatePrCtx>('create-pr'),
    assertHasBranchLeaf(),
    derivePrContentLeaf(opts.tasks ?? []),
    createPullRequestLeaf(useCase),
    recordPrUrlLeaf(),
  ]);
}

function assertHasBranchLeaf(): Element<CreatePrCtx> {
  return new Leaf<CreatePrCtx, { readonly sprint: Sprint }, void>('assert-has-branch', {
    useCase: {
      async execute(input) {
        if (input.sprint.branch === null) {
          return Promise.resolve(
            Result.error(
              new InvalidStateError({
                entity: 'sprint',
                currentState: 'no-branch',
                attemptedAction: 'create-pr',
                message: 'sprint has no branch — start the sprint with --branch first',
              })
            )
          );
        }
        return Promise.resolve(Result.ok(undefined));
      },
    },
    input: (ctx) => {
      if (!ctx.sprint) throw new Error('assert-has-branch: ctx.sprint must be loaded first');
      return { sprint: ctx.sprint };
    },
    output: (ctx) => ctx,
  });
}

function derivePrContentLeaf(tasks: readonly Task[]): Element<CreatePrCtx> {
  return new Leaf<CreatePrCtx, { readonly sprint: Sprint }, { readonly title: string; readonly body: string }>(
    'derive-pr-content',
    {
      useCase: {
        async execute(input) {
          const derived = derivePrContent(input.sprint, tasks);
          return Promise.resolve(Result.ok(derived));
        },
      },
      input: (ctx) => {
        if (!ctx.sprint) throw new Error('derive-pr-content: ctx.sprint must be loaded first');
        return { sprint: ctx.sprint };
      },
      output: (ctx, derived) => ({
        ...ctx,
        tasks,
        resolvedTitle: ctx.title ?? derived.title,
        resolvedBody: ctx.body ?? derived.body,
      }),
    }
  );
}

function createPullRequestLeaf(useCase: CreatePullRequestUseCase): Element<CreatePrCtx> {
  return new Leaf<
    CreatePrCtx,
    {
      readonly sprint: Sprint;
      readonly cwd: AbsolutePath;
      readonly base: string;
      readonly draft: boolean;
      readonly title: string;
      readonly body: string;
    },
    { readonly sprint: Sprint; readonly url: string }
  >('create-pull-request', {
    useCase: {
      async execute(input) {
        const result = await useCase.execute({
          sprint: input.sprint,
          cwd: input.cwd,
          base: input.base,
          title: input.title,
          body: input.body,
          draft: input.draft,
        });
        if (!result.ok) return Result.error(result.error);
        return Result.ok({ sprint: result.value.sprint, url: result.value.url });
      },
    },
    input: (ctx) => {
      if (!ctx.sprint) throw new Error('create-pull-request: ctx.sprint must be loaded first');
      const title = ctx.resolvedTitle ?? ctx.title;
      const body = ctx.resolvedBody ?? ctx.body;
      if (title === undefined) throw new Error('create-pull-request: title not resolved');
      if (body === undefined) throw new Error('create-pull-request: body not resolved');
      return {
        sprint: ctx.sprint,
        cwd: ctx.cwd,
        base: ctx.base,
        draft: ctx.draft,
        title,
        body,
      };
    },
    output: (ctx, out) => ({ ...ctx, sprint: out.sprint, pullRequestUrl: out.url }),
  });
}

/**
 * Final mirror leaf — the use case has already saved the sprint with the
 * URL recorded; this leaf is a no-op that documents the trace point and
 * keeps `pullRequestUrl` legible on the context for downstream consumers.
 */
function recordPrUrlLeaf(): Element<CreatePrCtx> {
  return new Leaf<CreatePrCtx, { readonly url: string | undefined }, void>('record-pr-url', {
    useCase: {
      async execute() {
        return Promise.resolve(Result.ok(undefined));
      },
    },
    input: (ctx) => ({ url: ctx.pullRequestUrl }),
    output: (ctx) => ctx,
  });
}
