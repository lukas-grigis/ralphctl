/**
 * `RecoverDirtyTreeUseCase` — fence against a dirty working tree after task
 * (or feedback) settlement.
 *
 * The generator and feedback prompts are instructed to commit their work
 * and the evaluator stays read-only — so reaching settlement with
 * uncommitted changes is a deviation, not the normal path. The harness's
 * philosophy is "never block left and right", so this use case:
 *
 *   1. checks the working tree;
 *   2. if dirty, builds a `chore(harness): auto-commit ...` message and
 *      asks the external port to commit;
 *   3. treats `autoCommit` failures as **non-fatal** — logs a warning and
 *      returns `{ committed: false }`, NEVER propagates the error.
 *
 * Blocking task completion on a missing git identity / pre-commit hook
 * rejection is strictly worse than proceeding — the evaluator preview
 * already flags dirty trees as a Completeness fail, so the human still
 * sees the deviation through that channel.
 */
import type { DomainError } from '../../../domain/errors/domain-error.ts';
import { StorageError } from '../../../domain/errors/storage-error.ts';
import { Result } from '../../../domain/result.ts';
import type { AbsolutePath } from '../../../domain/values/absolute-path.ts';
import type { SprintId } from '../../../domain/values/sprint-id.ts';
import type { ExternalPort } from '../../ports/external-port.ts';
import type { LoggerPort } from '../../ports/logger-port.ts';

export interface RecoverDirtyTreeInput {
  readonly projectPath: AbsolutePath;
  /** Task name surfaced in the auto-commit message. */
  readonly taskName: string;
  readonly sprintId: SprintId;
}

export interface RecoverDirtyTreeOutput {
  readonly committed: boolean;
  /** The commit message used, when an auto-commit was attempted. */
  readonly commitMessage?: string;
}

export class RecoverDirtyTreeUseCase {
  constructor(
    private readonly external: ExternalPort,
    private readonly logger: LoggerPort
  ) {}

  async execute(input: RecoverDirtyTreeInput): Promise<Result<RecoverDirtyTreeOutput, DomainError>> {
    const log = this.logger.child({
      sprintId: input.sprintId,
      projectPath: input.projectPath,
    });

    if (!this.external.hasUncommittedChanges(input.projectPath)) {
      return Result.ok({ committed: false });
    }

    const message = `chore(harness): auto-commit leftover changes from "${input.taskName}" [${input.sprintId}]`;
    log.warn('dirty tree after task settlement — auto-committing', {
      taskName: input.taskName,
    });

    const committed = await this.external.autoCommit(input.projectPath, message);
    if (!committed.ok) {
      // Detect a clean-tree no-op via the dedicated sub-code instead of
      // matching on the message string (legacy parity: pre-cleanup the
      // adapter emitted `subCode: 'io', message: 'no changes'`).
      if (committed.error instanceof StorageError && committed.error.subCode === 'no-changes') {
        return Result.ok({ committed: false });
      }
      // Non-blocking by contract — log and continue. See header comment.
      log.error('auto-commit failed (non-blocking)', {
        message: committed.error.message,
      });
      return Result.ok({ committed: false, commitMessage: message });
    }

    return Result.ok({ committed: true, commitMessage: message });
  }
}
