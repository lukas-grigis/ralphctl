import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { SprintExecution } from '@src/domain/entity/sprint-execution.ts';
import { setExecutionBranch } from '@src/domain/entity/sprint-execution.ts';
import type { Save } from '@src/domain/repository/_base/save.ts';
import type { GitRunner } from '@src/integration/io/git-runner.ts';
import { gitCreateAndCheckoutBranch } from '@src/integration/io/git-operations.ts';
import { generateBranchName, isValidBranchName } from '@src/integration/io/branch-name.ts';
import type { InteractivePrompt } from '@src/business/interactive/prompt.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';

/**
 * One-shot leaf — pins every repo touched by the sprint to its designated branch before any
 * task runs.
 *
 * First run (execution.branch === null): ask the user how to pin the tree — keep current /
 * auto-generate `ralphctl/<sprint-id>` / type a custom name. The answer is persisted on the
 * SprintExecution so subsequent runs skip the prompt.
 *
 * Resume (execution.branch is a non-empty string): reuse it verbatim.
 *
 * Explicit no-enforcement (execution.branch === ''): the user previously picked "keep current".
 * Skip checkout and leave `ctx.expectedBranch` undefined so per-task `branch-preflight` becomes
 * a no-op.
 *
 * For the auto-generate and custom cases the leaf calls `git checkout` at every cwd in
 * `opts.cwds` (the unique set of repos referenced by the sprint's todo tasks). The op is
 * idempotent: no-op when already on the branch, fast-forward when the branch exists locally,
 * `-b` otherwise. No remote fetch / pull — branch hygiene against `origin/main` is the user's
 * job. Multi-repo projects get the same branch name created/checked-out in each affected repo
 * so per-task commits land on the right ref regardless of which repo the task targets.
 *
 * Failure semantics: any error from persistence, git, or the prompt is fatal. Implementation
 * must not run against an unverified working tree.
 */

export interface ResolveBranchLeafDeps {
  readonly gitRunner: GitRunner;
  readonly sprintExecutionRepo: Save<SprintExecution>;
  readonly interactive: InteractivePrompt;
  readonly logger: Logger;
}

export interface ResolveBranchLeafOpts {
  /**
   * Unique set of repository working-tree paths to pin to the sprint branch. Derived from the
   * tasks the implement chain will run; empty when the sprint has no runnable tasks (in which
   * case the caller shouldn't have composed this leaf in).
   */
  readonly cwds: readonly AbsolutePath[];
}

interface ResolveBranchInput {
  readonly execution: SprintExecution;
}

interface ResolveBranchOutput {
  readonly execution: SprintExecution;
  /** Empty string ⇒ "keep current, no enforcement"; non-empty ⇒ the checked-out branch. */
  readonly branch: string;
}

type Strategy = 'keep' | 'auto' | 'custom';

const askCustomName = async (interactive: InteractivePrompt): Promise<Result<string, InvalidStateError>> => {
  // Re-prompt up to three times; bail with InvalidStateError after that so the user gets out
  // of an unresponsive loop. Three attempts mirrors common shell tooling.
  for (let i = 0; i < 3; i++) {
    const answer = await interactive.askText('Branch name?');
    if (!answer.ok) {
      return Result.error(
        new InvalidStateError({
          entity: 'sprint-execution',
          currentState: 'resolve-branch',
          attemptedAction: 'ask-custom-branch-name',
          message: `resolve-branch: prompt cancelled — ${answer.error.message}`,
        })
      );
    }
    if (isValidBranchName(answer.value)) return Result.ok(answer.value);
  }
  return Result.error(
    new InvalidStateError({
      entity: 'sprint-execution',
      currentState: 'resolve-branch',
      attemptedAction: 'ask-custom-branch-name',
      message: 'resolve-branch: gave up after 3 invalid branch names',
    })
  );
};

const resolveFirstRun = async (
  deps: ResolveBranchLeafDeps,
  sprintId: string
): Promise<Result<string, InvalidStateError>> => {
  const generated = generateBranchName(sprintId);
  const choice = await deps.interactive.askChoice<Strategy>('Branch strategy?', [
    {
      label: 'Keep current branch (no enforcement)',
      value: 'keep',
      description: 'do not switch — run tasks on whatever ref is currently checked out',
    },
    {
      label: `Auto-generate (${generated})`,
      value: 'auto',
      description: `create / fast-forward '${generated}' and check it out`,
    },
    { label: 'Custom name', value: 'custom', description: 'I will type the branch name' },
  ]);
  if (!choice.ok) {
    return Result.error(
      new InvalidStateError({
        entity: 'sprint-execution',
        currentState: 'resolve-branch',
        attemptedAction: 'ask-branch-strategy',
        message: `resolve-branch: prompt cancelled — ${choice.error.message}`,
      })
    );
  }
  switch (choice.value) {
    case 'keep':
      return Result.ok('');
    case 'auto':
      return Result.ok(generated);
    case 'custom':
      return askCustomName(deps.interactive);
  }
};

export const resolveBranchLeaf = (deps: ResolveBranchLeafDeps, opts: ResolveBranchLeafOpts): Element<ImplementCtx> =>
  leaf<ImplementCtx, ResolveBranchInput, ResolveBranchOutput>('resolve-branch', {
    useCase: {
      execute: async (input) => {
        const log = deps.logger.named('branch.resolve');
        let execution = input.execution;

        // First-run path: ask the user. Persist the decision so re-runs reuse it.
        if (execution.branch === null) {
          const resolved = await resolveFirstRun(deps, String(execution.sprintId));
          if (!resolved.ok) return Result.error(resolved.error);
          execution = setExecutionBranch(execution, resolved.value);
          const saved = await deps.sprintExecutionRepo.save(execution);
          if (!saved.ok) return Result.error(saved.error);
          log.info(
            resolved.value === ''
              ? 'branch strategy: keep current (no enforcement)'
              : `assigned branch '${resolved.value}' to sprint`,
            { sprintId: execution.sprintId, branch: resolved.value }
          );
        } else {
          log.debug('reusing existing sprint branch', { sprintId: execution.sprintId, branch: execution.branch });
        }

        const branch = execution.branch ?? '';
        if (branch === '') {
          // Explicit no-enforcement; skip checkout, leave ctx.expectedBranch undefined.
          return Result.ok({ execution, branch });
        }

        if (!isValidBranchName(branch)) {
          return Result.error(
            new InvalidStateError({
              entity: 'sprint-execution',
              currentState: 'pre-resolve-branch',
              attemptedAction: 'resolve-branch',
              message: `resolve-branch: invalid branch name '${branch}'`,
            })
          );
        }

        for (const cwd of opts.cwds) {
          const checkout = await gitCreateAndCheckoutBranch(deps.gitRunner, cwd, branch);
          if (!checkout.ok) return Result.error(checkout.error);
          log.info(`checked out '${branch}' at ${String(cwd)}`);
        }

        return Result.ok({ execution, branch });
      },
    },
    input: (ctx) => {
      if (ctx.execution === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-resolve-branch',
          attemptedAction: 'resolve-branch',
          message: 'resolve-branch: ctx.execution is undefined — load-sprint-execution must run first',
        });
      }
      return { execution: ctx.execution };
    },
    output: (ctx, out) => {
      const next: ImplementCtx = { ...ctx, execution: out.execution };
      // Only stamp expectedBranch when a real branch was checked out — empty string means the
      // user chose "keep current", which the per-task branch-preflight must not enforce.
      if (out.branch === '') return next;
      return { ...next, expectedBranch: out.branch };
    },
  });
