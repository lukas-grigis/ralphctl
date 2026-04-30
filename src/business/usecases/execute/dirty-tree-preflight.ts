/**
 * `DirtyTreePreflightUseCase` — sprint-start fence that surveys every repo
 * the sprint will touch and, if any have uncommitted changes, asks the user
 * how to handle them.
 *
 * Outcomes:
 *  - `clean`     — no dirty repos; chain proceeds as normal
 *  - `stashed`   — every dirty repo got a `git stash push -u` (recoverable)
 *  - `reset`     — every dirty repo got `git reset --hard` + `git clean -fd`
 *                  (DESTRUCTIVE; gated behind a second confirmation)
 *  - `continued` — user chose to proceed with a dirty tree (warning logged)
 *  - `cancelled` — user backed out; the chain should short-circuit
 *
 * The use case never throws — every prompt cancellation collapses into
 * `outcome: 'cancelled'` so the caller has a single decision branch.
 */
import type { DomainError } from '../../../domain/errors/domain-error.ts';
import { Result } from '../../../domain/result.ts';
import type { AbsolutePath } from '../../../domain/values/absolute-path.ts';
import type { ExternalPort } from '../../ports/external-port.ts';
import type { LoggerPort } from '../../ports/logger-port.ts';
import { PromptCancelledError, type PromptPort } from '../../ports/prompt-port.ts';

/** Strategy for handling a group of dirty repos. */
export type DirtyTreeAction = 'stash' | 'reset' | 'continue' | 'cancel';

export interface DirtyTreePreflightInput {
  /** Repositories the sprint will touch (one entry per unique path). */
  readonly repoPaths: readonly AbsolutePath[];
  /** Stash message used when the user picks "stash". */
  readonly stashMessage: string;
}

export interface DirtyTreePreflightOutput {
  readonly outcome: 'clean' | 'stashed' | 'reset' | 'continued' | 'cancelled';
  /** Repos that were dirty at the time of the survey. */
  readonly dirtyRepos: readonly AbsolutePath[];
}

export class DirtyTreePreflightUseCase {
  constructor(
    private readonly external: ExternalPort,
    private readonly prompt: PromptPort,
    private readonly logger: LoggerPort
  ) {}

  async execute(input: DirtyTreePreflightInput): Promise<Result<DirtyTreePreflightOutput, DomainError>> {
    const dirtyRepos = input.repoPaths.filter((p) => this.external.hasUncommittedChanges(p));
    if (dirtyRepos.length === 0) {
      return Result.ok({ outcome: 'clean', dirtyRepos });
    }

    const log = this.logger.child({ dirtyRepoCount: dirtyRepos.length });
    log.warn('uncommitted changes detected — prompting user', {
      repos: dirtyRepos.join(', '),
    });

    const action = await this.askForAction(dirtyRepos);
    if (action === 'cancel') {
      return Result.ok({ outcome: 'cancelled', dirtyRepos });
    }

    if (action === 'continue') {
      log.warn('proceeding with dirty working tree', {
        repos: dirtyRepos.join(', '),
      });
      return Result.ok({ outcome: 'continued', dirtyRepos });
    }

    if (action === 'stash') {
      for (const repo of dirtyRepos) {
        const r = await this.external.stashChanges(repo, input.stashMessage);
        if (!r.ok) {
          log.error('stash failed', { repo, message: r.error.message });
          return Result.error(r.error);
        }
        log.info('stashed changes', { repo, message: input.stashMessage });
      }
      return Result.ok({ outcome: 'stashed', dirtyRepos });
    }

    // action === 'reset' — second confirmation, then hard reset every repo.
    const ok = await this.confirmReset(dirtyRepos);
    if (!ok) {
      return Result.ok({ outcome: 'cancelled', dirtyRepos });
    }
    for (const repo of dirtyRepos) {
      const r = await this.external.hardResetWorkingTree(repo);
      if (!r.ok) {
        log.error('hard reset failed', { repo, message: r.error.message });
        return Result.error(r.error);
      }
      log.warn('hard-reset working tree', { repo });
    }
    return Result.ok({ outcome: 'reset', dirtyRepos });
  }

  private async askForAction(dirtyRepos: readonly AbsolutePath[]): Promise<DirtyTreeAction> {
    try {
      return await this.prompt.select<DirtyTreeAction>({
        message: `Uncommitted changes in ${String(dirtyRepos.length)} repo(s). How should ralphctl handle them?`,
        choices: [
          {
            label: 'Stash changes and continue (recoverable via git stash pop)',
            value: 'stash',
          },
          {
            label: 'Reset hard (DESTRUCTIVE — discards all changes)',
            value: 'reset',
          },
          {
            label: 'Continue without staging (proceed with dirty tree)',
            value: 'continue',
          },
          { label: 'Cancel start', value: 'cancel' },
        ],
        default: 'stash',
      });
    } catch (err) {
      if (err instanceof PromptCancelledError) return 'cancel';
      throw err;
    }
  }

  private async confirmReset(dirtyRepos: readonly AbsolutePath[]): Promise<boolean> {
    try {
      const list = dirtyRepos.map((p) => `  - ${p}`).join('\n');
      return await this.prompt.confirm({
        message: 'Reset hard? This permanently discards all uncommitted changes.',
        default: false,
        details: `The following repos will lose all uncommitted changes:\n${list}`,
      });
    } catch (err) {
      if (err instanceof PromptCancelledError) return false;
      throw err;
    }
  }
}
