import { Result } from '@src/domain/result.ts';
import { recordExecutionPullRequestUrl } from '@src/domain/entity/sprint-execution.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { derivePrContent, renderWarningsSection } from '@src/business/sprint/views/pr-content.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';

import type { CreatePrCtx, CreatePrInput, CreatePrOutput } from '@src/application/flows/create-pr/ctx.ts';
import type { CreatePrDeps } from '@src/application/flows/create-pr/deps.ts';

const ALLOWED_STATUSES = ['review', 'done'] as const;

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

        if (!ALLOWED_STATUSES.includes(sprint.value.status as (typeof ALLOWED_STATUSES)[number])) {
          return Result.error(
            new InvalidStateError({
              entity: 'sprint',
              currentState: sprint.value.status,
              attemptedAction: 'create-pr',
              message: `cannot create-pr on sprint in '${sprint.value.status}' status — allowed: ${ALLOWED_STATUSES.join(', ')}`,
            })
          );
        }

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

        // Honour caller-supplied tasks (override seam); otherwise load from the repo.
        let tasks = input.tasks;
        if (tasks === undefined) {
          const loaded = await deps.taskRepo.findBySprintId(input.sprintId);
          if (!loaded.ok) return Result.error(loaded.error);
          tasks = loaded.value;
        }
        const derived = derivePrContent(sprint.value, tasks);
        // Precedence: explicit override > AI-authored content > template-derived default.
        const title = input.title ?? input.aiContent?.title ?? derived.title;
        const resolvedBody = input.body ?? input.aiContent?.body ?? derived.body;
        // Warnings honesty: `derived.body` already carries the `## Completed with warnings`
        // section; the override / AI-authored bodies do not. Append it harness-side for those two
        // paths so a flagged task never lands in the PR without qualification regardless of which
        // body wins. Deterministic + reliable — no template param to thread or keep in sync.
        const usingDerivedBody = input.body === undefined && input.aiContent?.body === undefined;
        const warningsSection = usingDerivedBody ? '' : renderWarningsSection(tasks);
        const body = warningsSection.length > 0 ? `${resolvedBody}\n\n${warningsSection}` : resolvedBody;

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

        const recorded = recordExecutionPullRequestUrl(execution, created.value.url);
        if (!recorded.ok) {
          deps.eventBus.publish({
            type: 'log',
            level: 'error',
            message: `create-pr: PR opened at ${created.value.url} but URL failed validation — record manually`,
            meta: { url: created.value.url },
            at: deps.clock(),
          });
          return Result.error(recorded.error);
        }

        const saved = await deps.sprintExecutionRepo.save(recorded.value);
        if (!saved.ok) {
          deps.eventBus.publish({
            type: 'log',
            level: 'error',
            message: `create-pr: PR opened at ${created.value.url} but persistence failed — re-run will not re-open the PR`,
            meta: { url: created.value.url },
            at: deps.clock(),
          });
          return Result.error(saved.error);
        }

        deps.eventBus.publish({
          type: 'log',
          level: 'info',
          message: `create-pr: ${created.value.platform === 'github' ? 'PR' : 'MR'} opened at ${created.value.url}`,
          meta: {
            sprintId: String(execution.sprintId),
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
