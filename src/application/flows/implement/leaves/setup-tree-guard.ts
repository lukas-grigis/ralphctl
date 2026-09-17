import { Result } from '@src/domain/result.ts';
import { recordSetupTree, type SetupTreeOutcome, type SetupTreeRecord } from '@src/domain/entity/sprint-execution.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { InteractivePrompt } from '@src/business/interactive/prompt.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import {
  type DirtyTreePolicy,
  type DirtyTreeResolution,
  preflightTaskUseCase,
} from '@src/business/task/preflight-task.ts';
import type { GitRunner } from '@src/integration/io/git-runner.ts';
import {
  gitStatusSnapshot,
  porcelainEntryKey,
  porcelainEntryPaths,
  type PorcelainEntry,
} from '@src/integration/io/git-tree-snapshot.ts';
import { dirtyTreeMenu } from '@src/application/flows/implement/leaves/preflight-task.ts';

/**
 * Runs once a repo's setup script has exited green: resolves any working-tree change the script
 * introduced (under the run's dirty-tree policy) and returns the durable answer — how it was
 * settled, and which paths the operator has now seen. `setup-script-runner` persists that answer
 * on the `SetupRun` row and lifts it onto `ctx.setupTreeRecords`, where each parallel task
 * worktree reads it (`worktree-setup-tree.ts`).
 */
export type SetupTreeCheck = (input: { readonly command: string }) => Promise<Result<SetupTreeRecord, DomainError>>;

/**
 * Snapshots `cwd` immediately before its setup script spawns and returns the matching
 * {@link SetupTreeCheck}. Injected into `setup-script-runner`, which stays free of git and prompt
 * wiring.
 */
export type SetupTreeGuard = (cwd: AbsolutePath) => Promise<Result<SetupTreeCheck, DomainError>>;

const ELEMENT_NAME = 'setup-script-runner';
/** How many introduced paths the log line names before summarising the rest. */
const LOGGED_PATHS_MAX = 5;

export interface SetupTreeGuardDeps {
  readonly gitRunner: GitRunner;
  readonly interactive: InteractivePrompt;
  readonly clock: () => IsoTimestamp;
  readonly logger: Logger;
}

export interface SetupTreeGuardOpts {
  /** The run's dirty-tree policy — the same one the pre-setup preflight applied. */
  readonly policy: DirtyTreePolicy;
  /** Surfaced in the stash message so the operator can find a stash later. */
  readonly sprintId: string;
}

const plural = (n: number, one: string, many: string): string => `${String(n)} ${n === 1 ? one : many}`;

/** Up to {@link LOGGED_PATHS_MAX} paths, then a count of the rest. Shared with the worktree check. */
export const describePaths = (paths: readonly string[]): string => {
  const named = paths.slice(0, LOGGED_PATHS_MAX);
  const rest = paths.length - named.length;
  return rest > 0 ? `${named.join(', ')} and ${String(rest)} more` : named.join(', ');
};

/** The operator's answer, as the durable record names it. A clean tree means nothing was introduced. */
const OUTCOME_OF: Readonly<Record<DirtyTreeResolution, SetupTreeOutcome>> = {
  clean: 'unchanged',
  kept: 'kept',
  stashed: 'stashed',
  reset: 'reset',
};

/**
 * The flow's {@link SetupTreeGuard}: compares `git status` right before and right after a repo's
 * setup script and acts ONLY on entries the script introduced. Anything already in the tree —
 * dirt the operator chose to keep at the pre-setup menu — is never asked about again, so a
 * well-behaved setup adds no prompt.
 *
 * Introduced entries are resolved with the same policy semantics as the pre-setup preflight:
 *
 *   - `'prompt'`   — the same keep / stash / reset / cancel menu, naming the script as the cause.
 *     Stash and reset act on the whole tree, so the question says so when the tree already held
 *     changes before setup.
 *   - `'continue'` — log what the script changed and proceed; the first task's commit includes it.
 *   - `'cancel'`   — fail the run with an error naming the script.
 *
 * The comparison works at porcelain-entry granularity: a script that further edits a file already
 * listed as modified (or writes inside an already-untracked directory) leaves the entry unchanged
 * and is not reported — that path is already part of what the operator chose to keep. Those
 * pre-existing paths still go into the record's `seenPaths`: a fresh task worktree has no such
 * dirt, so there the same script's edit DOES show up as new, and the record is how that worktree
 * knows the operator already saw it.
 */
export const createSetupTreeGuard =
  (deps: SetupTreeGuardDeps, opts: SetupTreeGuardOpts): SetupTreeGuard =>
  async (cwd) => {
    const before = await gitStatusSnapshot(deps.gitRunner, cwd);
    if (!before.ok) return Result.error(before.error);
    const settled = new Set(before.value.map(porcelainEntryKey));

    const check: SetupTreeCheck = async ({ command }) => {
      const after = await gitStatusSnapshot(deps.gitRunner, cwd);
      if (!after.ok) return Result.error(after.error);
      const introduced = after.value.filter((entry) => !settled.has(porcelainEntryKey(entry)));
      // Introduced paths first: they are what the same script will write into every fresh
      // worktree, so a list too long even once collapsed into directories keeps them.
      const seenPaths = [...introduced, ...before.value].flatMap(porcelainEntryPaths);
      if (introduced.length === 0) return Result.ok(recordSetupTree('unchanged', seenPaths));

      const resolved = await resolveIntroducedDirt(deps, opts, {
        cwd,
        command,
        introduced,
        dirtyEntries: after.value.length,
        preExisting: settled.size,
      });
      if (!resolved.ok) return Result.error(resolved.error);
      return Result.ok(recordSetupTree(OUTCOME_OF[resolved.value], seenPaths));
    };
    return Result.ok(check);
  };

interface IntroducedDirt {
  readonly cwd: AbsolutePath;
  readonly command: string;
  /** Entries absent from the pre-setup snapshot. */
  readonly introduced: readonly PorcelainEntry[];
  /** Every porcelain entry now in the tree — introduced plus pre-existing. */
  readonly dirtyEntries: number;
  /** Entries that were already in the tree before the script ran. */
  readonly preExisting: number;
}

const resolveIntroducedDirt = async (
  deps: SetupTreeGuardDeps,
  opts: SetupTreeGuardOpts,
  dirt: IntroducedDirt
): ReturnType<typeof preflightTaskUseCase> => {
  const log = deps.logger.named('implement.setup-tree');
  const paths = dirt.introduced.map((entry) => entry.path);
  const changed = plural(dirt.introduced.length, 'new or modified entry', 'new or modified entries');
  const headline = `setup script \`${dirt.command}\` changed the working tree at ${String(dirt.cwd)}: ${changed}`;
  log.warn(`${headline} (${describePaths(paths)})`, { cwd: dirt.cwd, command: dirt.command, entries: paths });

  if (opts.policy === 'continue') {
    log.warn('proceeding (policy=continue) — the first task commit will include these changes', { cwd: dirt.cwd });
    return Result.ok('kept');
  }

  if (opts.policy === 'cancel') {
    return Result.error(
      new InvalidStateError({
        entity: 'working-tree',
        currentState: 'dirty',
        attemptedAction: 'setup-script',
        message: `${headline} — refusing to start tasks on it`,
        hint: 'Make the setup script leave the tree unchanged (e.g. a frozen-lockfile install) or ignore what it generates, or launch implement from the TUI, which offers keep / stash / reset.',
      })
    );
  }

  const caveat =
    dirt.preExisting > 0
      ? ` Stash and Reset also cover the ${plural(dirt.preExisting, 'change', 'changes')} already in the tree before setup.`
      : '';
  const menu = dirtyTreeMenu(deps, {
    elementName: ELEMENT_NAME,
    question: () =>
      `Setup script \`${dirt.command}\` changed the working tree at ${String(dirt.cwd)} — ${changed}.${caveat} How do you want to handle it?`,
  });
  return preflightTaskUseCase({
    cwd: dirt.cwd,
    // The tree was just read; hand the use case that count instead of probing again.
    gitStatusEntryCount: () => Promise.resolve(Result.ok(dirt.dirtyEntries)),
    ...menu,
    dirtyTreePolicy: 'prompt',
    clock: deps.clock,
    sprintId: opts.sprintId,
    logger: deps.logger,
  });
};
