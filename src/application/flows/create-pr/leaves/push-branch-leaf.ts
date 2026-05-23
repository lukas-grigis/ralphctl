import { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { gitGetCurrentBranch } from '@src/integration/io/git-operations.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';

import type { CreatePrCtx } from '@src/application/flows/create-pr/ctx.ts';
import type { CreatePrDeps } from '@src/application/flows/create-pr/deps.ts';

interface PushBranchInput {
  readonly sprintId: CreatePrCtx['input']['sprintId'];
  readonly cwd: AbsolutePath;
}

/**
 * Push the sprint branch to `origin` before `gh` / `glab` is asked to open a PR.
 *
 * Why: `gh pr create` / `glab mr create` both require the head branch to exist on the
 * remote — when ralphctl runs in a non-TTY spawn the platform CLI can't prompt the user
 * to push, so the call fails opaquely. This leaf surfaces and fixes that failure mode by
 * doing a plain `git push -u origin <branch>` first.
 *
 * Drift guard: the leaf reads the current branch via `git rev-parse --abbrev-ref HEAD` and
 * refuses to push when the working tree is sitting on something other than the sprint's
 * recorded branch — preventing a misconfigured cwd from pushing the wrong ref under the
 * sprint's name.
 *
 * Plain `git push -u origin <branch>` — no `--force`, no `--force-with-lease`. If the
 * remote has diverged (someone else pushed to the same ref), the harness must surface the
 * failure rather than overwrite remote history.
 */
export const createPushBranchLeaf = (deps: CreatePrDeps): Element<CreatePrCtx> =>
  leaf<CreatePrCtx, PushBranchInput, void>(
    'push-branch',
    {
      useCase: {
        async execute(input) {
          const execLoaded = await deps.sprintExecutionRepo.findById(input.sprintId);
          if (!execLoaded.ok) return Result.error(execLoaded.error);
          const branch = execLoaded.value.branch;
          if (branch === null) {
            // The create-pr leaf carries the canonical "no branch" guard and will surface a
            // more descriptive InvalidStateError. Pre-empting it here would be redundant; the
            // push leaf simply has nothing to push and short-circuits.
            return Result.ok(undefined);
          }

          const current = await gitGetCurrentBranch(deps.gitRunner, input.cwd);
          if (!current.ok) return Result.error(current.error);
          if (current.value !== branch) {
            return Result.error(
              new InvalidStateError({
                entity: 'sprint-execution',
                currentState: 'wrong-branch',
                attemptedAction: 'create-pr',
                message: `create-pr: checked out '${current.value}' but sprint branch is '${branch}' — switch first`,
              })
            );
          }

          deps.eventBus.publish({
            type: 'log',
            level: 'info',
            message: `create-pr: pushing ${branch} to origin`,
            meta: { sprintId: String(input.sprintId), branch },
            at: deps.clock(),
          });

          const pushed = await deps.gitRunner.run(input.cwd, ['push', '-u', 'origin', branch]);
          if (!pushed.ok) return Result.error(pushed.error);
          if (pushed.value.exitCode !== 0) {
            return Result.error(
              new StorageError({
                subCode: 'io',
                message: `git push failed: ${(pushed.value.stderr || pushed.value.stdout).trim()}`,
              })
            );
          }

          deps.eventBus.publish({
            type: 'log',
            level: 'info',
            message: `create-pr: ${branch} pushed (or already up to date)`,
            meta: { sprintId: String(input.sprintId), branch },
            at: deps.clock(),
          });

          return Result.ok(undefined);
        },
      },
      input: (c) => ({ sprintId: c.input.sprintId, cwd: c.input.cwd }),
      output: (c) => c,
    },
    { label: 'push branch to origin' }
  );
