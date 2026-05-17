import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { GitRunner } from '@src/integration/io/git-runner.ts';
import { gitGetCurrentBranch } from '@src/integration/io/git-operations.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';

/**
 * Per-task safety net — guards against branch drift between tasks. The implement flow's
 * `resolveBranchLeaf` pins the working tree to the sprint branch once, before any task runs;
 * an AI generator turn with shell access could in principle `git checkout` elsewhere mid-run,
 * which would then bury subsequent commits on the wrong ref. This leaf catches that drift.
 *
 * No-op when `ctx.expectedBranch` is unset — the caller composes this in only when a branch
 * resolution actually happened, so the absence is interpreted as "no expectation to enforce".
 *
 * On mismatch: halts with `InvalidStateError`. Match v2's "infrastructure failure halts the
 * chain" rule (commit-task / preflight-task share this stance). The user fixes the working
 * tree and re-runs.
 */

export interface BranchPreflightLeafDeps {
  readonly gitRunner: GitRunner;
  readonly logger: Logger;
}

export interface BranchPreflightLeafOpts {
  readonly cwd: AbsolutePath;
}

interface BranchPreflightInput {
  readonly expected: string | undefined;
}

export const branchPreflightLeaf = (
  deps: BranchPreflightLeafDeps,
  opts: BranchPreflightLeafOpts,
  name = 'branch-preflight'
): Element<ImplementCtx> =>
  leaf<ImplementCtx, BranchPreflightInput, void>(name, {
    useCase: {
      execute: async (input) => {
        if (input.expected === undefined) return Result.ok(undefined);

        const current = await gitGetCurrentBranch(deps.gitRunner, opts.cwd);
        if (!current.ok) return Result.error(current.error);

        if (current.value === input.expected) {
          deps.logger.named('branch.preflight').debug('on expected branch', { branch: input.expected });
          return Result.ok(undefined);
        }

        return Result.error(
          new InvalidStateError({
            entity: 'working-tree',
            currentState: `on '${current.value}'`,
            attemptedAction: 'verify expected branch',
            message: `branch-preflight: working tree drifted — expected '${input.expected}', got '${current.value}'`,
          })
        );
      },
    },
    input: (ctx) => ({ expected: ctx.expectedBranch }),
    output: (ctx) => ctx,
  });
