/**
 * `CreatePullRequestUseCase` — open a pull / merge request for a sprint
 * branch and persist the resulting URL on the sprint aggregate.
 *
 * Steps:
 *  1. Guard: the sprint must have a recorded `branch` — opening a PR for a
 *     sprint with no branch is a programmer error and surfaces an
 *     {@link InvalidStateError}.
 *  2. Delegate to {@link ExternalPort.createPullRequest}, which dispatches
 *     to `gh` or `glab` based on the repo's git remote.
 *  3. Record the URL via `Sprint.recordPullRequestUrl` and persist via
 *     {@link SprintRepository.save}. Validation (URL parse, http(s)
 *     protocol) happens inside the entity.
 *
 * The use case never invokes the platform CLI directly — that lives in
 * the integration adapter, where it can be swapped with a fake.
 */
import type { ExternalPort } from '@src/business/ports/external-port.ts';
import type { LoggerPort } from '@src/business/ports/logger-port.ts';
import type { Sprint } from '@src/domain/entities/sprint.ts';
import type { DomainError } from '@src/domain/errors/domain-error.ts';
import { InvalidStateError } from '@src/domain/errors/invalid-state-error.ts';
import type { SprintRepository } from '@src/domain/repositories/sprint-repository.ts';
import { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/values/absolute-path.ts';

/** Inputs to {@link CreatePullRequestUseCase}. */
export interface CreatePullRequestUseCaseInput {
  readonly sprint: Sprint;
  readonly cwd: AbsolutePath;
  readonly base: string;
  readonly title: string;
  readonly body: string;
  readonly draft: boolean;
}

/** Output of {@link CreatePullRequestUseCase}. */
export interface CreatePullRequestUseCaseOutput {
  /** Sprint aggregate updated with the recorded `pullRequestUrl`. */
  readonly sprint: Sprint;
  readonly url: string;
}

export class CreatePullRequestUseCase {
  constructor(
    private readonly external: ExternalPort,
    private readonly sprints: SprintRepository,
    private readonly logger: LoggerPort
  ) {}

  async execute(input: CreatePullRequestUseCaseInput): Promise<Result<CreatePullRequestUseCaseOutput, DomainError>> {
    if (input.sprint.branch === null) {
      return Result.error(
        new InvalidStateError({
          entity: 'sprint',
          currentState: 'no-branch',
          attemptedAction: 'create-pr',
          message: 'sprint has no branch — set one via `sprint start --branch` first',
        })
      );
    }

    this.logger.info('creating pull request', {
      sprintId: input.sprint.id,
      branch: input.sprint.branch,
      base: input.base,
      draft: input.draft,
    });

    const created = await this.external.createPullRequest({
      cwd: input.cwd,
      branch: input.sprint.branch,
      base: input.base,
      title: input.title,
      body: input.body,
      draft: input.draft,
    });
    if (!created.ok) return Result.error(created.error);

    const recorded = input.sprint.recordPullRequestUrl(created.value.url);
    if (!recorded.ok) return Result.error(recorded.error);

    const saved = await this.sprints.save(recorded.value);
    if (!saved.ok) return Result.error(saved.error);

    this.logger.info('pull request created', {
      sprintId: input.sprint.id,
      url: created.value.url,
    });

    return Result.ok({ sprint: recorded.value, url: created.value.url });
  }
}
