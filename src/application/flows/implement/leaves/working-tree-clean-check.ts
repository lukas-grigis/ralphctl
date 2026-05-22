import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf, type LeafOpts } from '@src/application/chain/build/leaf.ts';
import { gitStatusPorcelain } from '@src/integration/io/git-operations.ts';
import type { GitRunner } from '@src/integration/io/git-runner.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';

/**
 * Pre-setup hard gate — fails the chain when the user's working tree at `cwd` is dirty.
 *
 * Composed before `setup-script-runner` so the user sees branch + dirty-tree problems
 * surfaced *before* a multi-minute setup script runs. Rationale: setup commands often
 * `pnpm install --frozen-lockfile` or otherwise assume a "ready" tree; a dirty repo can
 * make setup fail in confusing ways. Catching dirt up-front lets the user kick off the
 * implement chain, see branch + setup turn green, and walk away with confidence.
 *
 * Contrast with {@link preflightTaskLeaf} which sits *after* setup and offers an
 * interactive recovery menu (Keep / Stash / Reset / Cancel). This leaf is intentionally
 * stricter — it has no menu, no recovery, no policy knob. Dirty → fail. Clean → continue.
 * If the user wants to keep / stash / reset, they do it manually before re-running
 * implement (or rely on the preflight-task leaf downstream that does have the menu).
 *
 * Resume exception: when `ctx.tasks` carries an `in_progress` task whose last attempt is
 * still `running` (the v8 OOM / Ctrl-C / SIGTERM / process-crash signature in a prior
 * process), the dirt almost always belongs to that prior crashed attempt — the AI may
 * have made changes the harness never had a chance to commit. Hard-aborting here strands
 * the operator: setup is already done, the sprint is active, and they can't make
 * forward progress without manually cleaning the tree. Instead, on detected resume we
 * downgrade to a warning and let the downstream `preflight-task` leaf surface its
 * Keep / Stash / Reset / Cancel menu — the operator decides whether the leftovers are
 * worth salvaging.
 *
 * One leaf per affected repo, sequenced together by the flow factory so all repos are
 * checked before any setup runs.
 *
 * Failure modes:
 *   - Dirty tree (no resume) → `InvalidStateError` with message containing
 *     `working-tree-dirty`.
 *   - `git status` spawn / non-zero exit → `InvalidStateError` with a hint pointing the
 *     user at PATH / git availability (the underlying `StorageError` is reported but
 *     not propagated up — InvalidStateError carries the cause in its message so the
 *     chain's failure semantics stay uniform: a single error class for hard-abort).
 */

export interface WorkingTreeCleanCheckLeafDeps {
  readonly gitRunner: GitRunner;
  readonly logger: Logger;
}

interface LeafInput {
  readonly cwd: AbsolutePath;
  /**
   * True when `ctx.tasks` shows at least one task whose last attempt is still `running`
   * (the prior-process crash signature). Derived in the `input` projector so the use case
   * stays pure.
   */
  readonly isResume: boolean;
}

/**
 * Resume detector — mirrors the launcher's `taskRecovering` predicate so chain-internal
 * decisions stay in sync with the launcher's TUI banner. Returns true when any task is
 * `in_progress` with a `running` last attempt.
 */
const detectResume = (tasks: readonly Task[] | undefined): boolean => {
  if (tasks === undefined) return false;
  for (const t of tasks) {
    if (t.status !== 'in_progress') continue;
    if (t.attempts.at(-1)?.status === 'running') return true;
  }
  return false;
};

export const workingTreeCleanCheckLeaf = (
  deps: WorkingTreeCleanCheckLeafDeps,
  cwd: AbsolutePath,
  name = 'working-tree-clean-check',
  opts?: LeafOpts
): Element<ImplementCtx> =>
  leaf<ImplementCtx, LeafInput, void>(
    name,
    {
      useCase: {
        execute: async (input): Promise<Result<void, DomainError>> => {
          const log = deps.logger.named('preflight.working-tree');
          const status = await gitStatusPorcelain(deps.gitRunner, input.cwd);
          if (!status.ok) {
            return Result.error(
              new InvalidStateError({
                entity: 'repository',
                currentState: 'unknown',
                attemptedAction: 'working-tree-clean-check',
                message: `working-tree-clean-check: git status failed at ${String(input.cwd)} — ${status.error.message}`,
                hint: 'Ensure `git` is on PATH and the path is a git working tree.',
              })
            );
          }
          if (status.value.length > 0) {
            if (input.isResume) {
              log.warn(
                `working-tree-dirty at ${String(input.cwd)} (${String(status.value.length)} uncommitted change(s)) — leftover from prior crashed attempt; deferring to preflight-task recovery menu`
              );
              return Result.ok(undefined);
            }
            return Result.error(
              new InvalidStateError({
                entity: 'repository',
                currentState: 'dirty',
                attemptedAction: 'working-tree-clean-check',
                message: `working-tree-dirty at ${String(input.cwd)} (${String(status.value.length)} uncommitted change(s))`,
                hint: `Commit, stash, or discard uncommitted changes in ${String(input.cwd)} before running implement.`,
              })
            );
          }
          log.info(`working-tree clean at ${String(input.cwd)}`);
          return Result.ok(undefined);
        },
      },
      input: (ctx) => ({ cwd, isResume: detectResume(ctx.tasks) }),
      output: (ctx) => ctx,
    },
    opts
  );
