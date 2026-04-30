/**
 * `BranchPreflightUseCase` — verify a repository is on the expected sprint
 * branch immediately before executing a task.
 *
 * Single-responsibility: reading the branch state and deciding whether to
 * proceed. Re-queueing on mismatch is a chain-layer concern; this use case
 * just surfaces the mismatch as an `InvalidStateError` so the chain can
 * decide between requeue, fallback, or fail-fast.
 */
import type { DomainError } from '../../../domain/errors/domain-error.ts';
import { InvalidStateError } from '../../../domain/errors/invalid-state-error.ts';
import { Result } from '../../../domain/result.ts';
import type { AbsolutePath } from '../../../domain/values/absolute-path.ts';
import type { ExternalPort } from '../../ports/external-port.ts';
import type { LoggerPort } from '../../ports/logger-port.ts';

/** Inputs to {@link BranchPreflightUseCase}. */
export interface BranchPreflightInput {
  /** Repository to inspect. */
  readonly projectPath: AbsolutePath;
  /** The sprint branch the task expects to run on. */
  readonly expectedBranch: string;
}

export class BranchPreflightUseCase {
  constructor(
    private readonly external: ExternalPort,
    private readonly logger: LoggerPort
  ) {}

  async execute(input: BranchPreflightInput): Promise<Result<void, DomainError>> {
    const log = this.logger.child({ projectPath: input.projectPath });
    const onExpected =
      input.expectedBranch.length > 0 ? this.external.verifyBranch(input.projectPath, input.expectedBranch) : true;

    if (onExpected) {
      log.debug('branch-preflight ok', { branch: input.expectedBranch });
      return Promise.resolve(Result.ok());
    }

    const actual = this.external.getCurrentBranch(input.projectPath);
    log.warn('branch-preflight mismatch', {
      expected: input.expectedBranch,
      actual,
    });
    return Promise.resolve(
      Result.error(
        new InvalidStateError({
          entity: 'repo',
          currentState: actual.length > 0 ? actual : 'unknown',
          attemptedAction: 'execute-task',
          message: `repo is on '${actual.length > 0 ? actual : 'unknown'}', expected '${input.expectedBranch}'`,
        })
      )
    );
  }
}
