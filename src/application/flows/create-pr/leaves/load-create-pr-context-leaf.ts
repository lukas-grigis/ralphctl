import { Result } from '@src/domain/result.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { Task } from '@src/domain/entity/task.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';

import type { CreatePrCtx, CreatePrInput } from '@src/application/flows/create-pr/ctx.ts';
import type { CreatePrDeps } from '@src/application/flows/create-pr/deps.ts';

interface LoadContextOutput {
  readonly sprint: Sprint;
  readonly tasks: readonly Task[];
  readonly headBranch: string;
}

/**
 * Load the sprint, tasks, and resolved head branch into ctx so the AI sub-chain has
 * everything it needs without re-querying the persistence ports per leaf.
 *
 * This sits at the head of the AI sub-chain (the AI step is opt-out via `--no-ai` / the
 * TUI `a` toggle). When the AI sub-chain is omitted (useAi=false), the downstream
 * create-pr leaf reloads internally — both paths reach the same persistence ports, the
 * difference is just whether the data is also threaded through ctx for the prompt builder.
 */
export const createLoadCreatePrContextLeaf = (deps: CreatePrDeps): Element<CreatePrCtx> =>
  leaf<CreatePrCtx, CreatePrInput, LoadContextOutput>('load-create-pr-context', {
    useCase: {
      execute: async (input) => {
        const sprint = await deps.sprintRepo.findById(input.sprintId);
        if (!sprint.ok) return Result.error(sprint.error);

        // Honour caller-supplied tasks (override seam matching create-pr-leaf); otherwise load.
        let tasks = input.tasks;
        if (tasks === undefined) {
          const loaded = await deps.taskRepo.findBySprintId(input.sprintId);
          if (!loaded.ok) return Result.error(loaded.error);
          tasks = loaded.value;
        }

        const exec = await deps.sprintExecutionRepo.findById(input.sprintId);
        if (!exec.ok) return Result.error(exec.error);
        if (exec.value.branch === null) {
          return Result.error(
            new InvalidStateError({
              entity: 'sprint-execution',
              currentState: 'no-branch',
              attemptedAction: 'load-create-pr-context',
              message: 'create-pr: sprint has no branch — set one via the run flow first',
            })
          );
        }

        return Result.ok({ sprint: sprint.value, tasks, headBranch: exec.value.branch });
      },
    },
    input: (c) => c.input,
    output: (c, o) => ({ ...c, sprint: o.sprint, tasks: o.tasks, headBranch: o.headBranch }),
  });
