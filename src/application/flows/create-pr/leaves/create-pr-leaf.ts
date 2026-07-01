import { Result } from '@src/domain/result.ts';
import { recordExecutionPullRequestUrl } from '@src/domain/entity/sprint-execution.ts';
import type { SprintExecution } from '@src/domain/entity/sprint-execution.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { Task } from '@src/domain/entity/task.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { derivePrContent, renderWarningsSection } from '@src/business/sprint/views/pr-content.ts';
import type { PullRequestCreatorOutput } from '@src/business/scm/pull-request-creator.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';

import type { CreatePrCtx, CreatePrInput, CreatePrOutput } from '@src/application/flows/create-pr/ctx.ts';
import type { CreatePrDeps } from '@src/application/flows/create-pr/deps.ts';

const ALLOWED_STATUSES = ['review', 'done'] as const;

/** Status whitelist guard — PRs open after work is implemented (see module doc for rationale). */
const assertSprintEligible = (sprint: Sprint): Result<void, InvalidStateError> => {
  if (ALLOWED_STATUSES.includes(sprint.status as (typeof ALLOWED_STATUSES)[number])) return Result.ok(undefined);
  return Result.error(
    new InvalidStateError({
      entity: 'sprint',
      currentState: sprint.status,
      attemptedAction: 'create-pr',
      message: `cannot create-pr on sprint in '${sprint.status}' status — allowed: ${ALLOWED_STATUSES.join(', ')}`,
    })
  );
};

/** Honour the caller-supplied tasks override (ctx-input seam); otherwise load from the repo. */
const resolveTasks = async (
  deps: CreatePrDeps,
  input: CreatePrInput
): Promise<Result<readonly Task[], DomainError>> => {
  if (input.tasks !== undefined) return Result.ok(input.tasks);
  const loaded = await deps.taskRepo.findBySprintId(input.sprintId);
  if (!loaded.ok) return Result.error(loaded.error);
  return Result.ok(loaded.value);
};

/**
 * Derive the PR title/body, honouring precedence `explicit override > AI-authored content >
 * template-derived default`, and append the harness-side warnings section when the winning
 * body isn't the template-derived one (see module doc: "Warnings honesty").
 */
const resolvePrContent = (
  sprint: Sprint,
  tasks: readonly Task[],
  input: CreatePrInput
): { readonly title: string; readonly body: string } => {
  const derived = derivePrContent(sprint, tasks);
  const title = input.title ?? input.aiContent?.title ?? derived.title;
  const resolvedBody = input.body ?? input.aiContent?.body ?? derived.body;
  const usingDerivedBody = input.body === undefined && input.aiContent?.body === undefined;
  const warningsSection = usingDerivedBody ? '' : renderWarningsSection(tasks);
  const body = warningsSection.length > 0 ? `${resolvedBody}\n\n${warningsSection}` : resolvedBody;
  return { title, body };
};

/**
 * Record the newly-created PR's URL onto the execution and persist it. Logs (and returns) the
 * failure at either step so the URL isn't silently lost when validation or persistence fails
 * after a successful PR open.
 */
const persistPrResult = async (
  deps: CreatePrDeps,
  execution: SprintExecution,
  created: PullRequestCreatorOutput
): Promise<Result<SprintExecution, DomainError>> => {
  const recorded = recordExecutionPullRequestUrl(execution, created.url);
  if (!recorded.ok) {
    deps.eventBus.publish({
      type: 'log',
      level: 'error',
      message: `create-pr: PR opened at ${created.url} but URL failed validation — record manually`,
      meta: { url: created.url },
      at: deps.clock(),
    });
    return Result.error(recorded.error);
  }

  const saved = await deps.sprintExecutionRepo.save(recorded.value);
  if (!saved.ok) {
    deps.eventBus.publish({
      type: 'log',
      level: 'error',
      message: `create-pr: PR opened at ${created.url} but persistence failed — re-run will not re-open the PR`,
      meta: { url: created.url },
      at: deps.clock(),
    });
    return Result.error(saved.error);
  }

  return Result.ok(recorded.value);
};

/**
 * Open a pull/merge request for the sprint's branch and persist the resulting URL.
 *
 * Linear: load → assert → load-exec → derive → create → record → save. The two SCM
 * side effects (PR creation, execution persistence) share an all-or-nothing semantic — if
 * PR creation fails we don't save; if save fails after a successful PR open, the URL is
 * logged so the user can recover manually.
 *
 * Status whitelist `['review', 'done']`: PRs open after work is implemented. `active`
 * (mid-work) would land an incomplete branch; `draft` / `planned` have no commits.
 *
 * Branch publication (`git push -u origin <branch>`) is handled upstream by the sibling
 * `push-branch-leaf` so the platform CLI doesn't see a remote-missing head.
 */
export const createCreatePrLeaf = (deps: CreatePrDeps): Element<CreatePrCtx> =>
  leaf<CreatePrCtx, CreatePrInput, CreatePrOutput>('create-pr', {
    useCase: {
      async execute(input) {
        const sprint = await deps.sprintRepo.findById(input.sprintId);
        if (!sprint.ok) return Result.error(sprint.error);

        const eligible = assertSprintEligible(sprint.value);
        if (!eligible.ok) return Result.error(eligible.error);

        const execLoaded = await deps.sprintExecutionRepo.findById(input.sprintId);
        if (!execLoaded.ok) return Result.error(execLoaded.error);
        const execution = execLoaded.value;

        if (execution.branch === null) {
          return Result.error(
            new InvalidStateError({
              entity: 'sprint-execution',
              currentState: 'no-branch',
              attemptedAction: 'create-pr',
              message: 'create-pr: sprint has no branch — set one via the run flow first',
            })
          );
        }

        const tasksLoaded = await resolveTasks(deps, input);
        if (!tasksLoaded.ok) return Result.error(tasksLoaded.error);
        const tasks = tasksLoaded.value;

        const { title, body } = resolvePrContent(sprint.value, tasks, input);

        deps.eventBus.publish({
          type: 'log',
          level: 'info',
          message: `create-pr: opening ${input.draft ? 'draft ' : ''}PR ${execution.branch} → ${input.base}`,
          meta: { sprintId: String(execution.sprintId), branch: execution.branch, base: input.base },
          at: deps.clock(),
        });

        const created = await deps.pullRequestCreator({
          cwd: input.cwd,
          branch: execution.branch,
          base: input.base,
          title,
          body,
          draft: input.draft,
        });
        if (!created.ok) return Result.error(created.error);

        const persisted = await persistPrResult(deps, execution, created.value);
        if (!persisted.ok) return Result.error(persisted.error);

        deps.eventBus.publish({
          type: 'log',
          level: 'info',
          message: `create-pr: ${created.value.platform === 'github' ? 'PR' : 'MR'} opened at ${created.value.url}`,
          meta: {
            sprintId: String(persisted.value.sprintId),
            url: created.value.url,
            platform: created.value.platform,
          },
          at: deps.clock(),
        });

        return Result.ok({ url: created.value.url });
      },
    },
    input: (c) => (c.aiContent !== undefined ? { ...c.input, aiContent: c.aiContent } : c.input),
    output: (c, o) => ({ ...c, output: o }),
  });
