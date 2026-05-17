import {
  preflightTaskUseCase,
  type DirtyTreePolicy,
  type PreflightTaskProps,
} from '@src/business/task/preflight-task.ts';

export type { DirtyTreePolicy };
import type { Logger } from '@src/business/observability/logger.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import { gitStatusPorcelain } from '@src/integration/io/git-operations.ts';
import type { GitRunner } from '@src/integration/io/git-runner.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';

export interface PreflightTaskLeafDeps {
  readonly gitRunner: GitRunner;
  readonly logger: Logger;
  readonly dirtyTreePolicy?: DirtyTreePolicy;
}

/**
 * Chain leaf — adapts ctx → preflightTaskUseCase → ctx. Wires the gitRunner to a function-shape
 * `gitStatusEntryCount` dep so the use case stays integration-agnostic. Business policy
 * (cancel vs continue on dirty tree) lives in `@src/business/task/preflight-task.ts`.
 */
export const preflightTaskLeaf = (
  deps: PreflightTaskLeafDeps,
  cwd: AbsolutePath,
  name = 'preflight-task'
): Element<ImplementCtx> => {
  const gitStatusEntryCount: PreflightTaskProps['gitStatusEntryCount'] = async (path) => {
    const status = await gitStatusPorcelain(deps.gitRunner, path);
    if (!status.ok) return status;
    return { ok: true, value: status.value.length } as Awaited<ReturnType<PreflightTaskProps['gitStatusEntryCount']>>;
  };

  return leaf<ImplementCtx, void, void>(name, {
    useCase: {
      execute: async () =>
        preflightTaskUseCase({
          cwd,
          gitStatusEntryCount,
          logger: deps.logger,
          ...(deps.dirtyTreePolicy !== undefined ? { dirtyTreePolicy: deps.dirtyTreePolicy } : {}),
        }),
    },
    input: () => undefined,
    output: (ctx) => ctx,
  });
};
