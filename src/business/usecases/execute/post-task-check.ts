/**
 * `PostTaskCheckUseCase` — run the project's check script as a gate after a
 * task settles. Returns a structured result the chain layer uses to decide
 * whether to mark the task done.
 *
 * Skip optimisation: when the caller passes `changedFilesSinceBaseline` and
 * the list is empty, the gate short-circuits with `skipped: true`. A task
 * that left no artefacts cannot have broken anything, and shaving the check
 * (typically a multi-minute install + lint + test) on those tasks compounds
 * across long sprints.
 */
import type { DomainError } from '../../../domain/errors/domain-error.ts';
import { Result } from '../../../domain/result.ts';
import type { AbsolutePath } from '../../../domain/values/absolute-path.ts';
import type { ExternalPort } from '../../ports/external-port.ts';
import type { LoggerPort } from '../../ports/logger-port.ts';

export interface PostTaskCheckInput {
  readonly projectPath: AbsolutePath;
  /** Resolved check script command (e.g. `pnpm test`). */
  readonly checkScript: string;
  /** Optional override for the default 5-minute timeout (in ms). */
  readonly timeoutMs?: number;
  /**
   * When provided, skip the check entirely if the list is empty (the task
   * left no artefacts so the gate is trivially satisfied). When omitted,
   * the check always runs.
   */
  readonly changedFilesSinceBaseline?: readonly string[];
}

export interface PostTaskCheckOutput {
  readonly passed: boolean;
  readonly output: string;
  /** True iff the gate was skipped because no files changed. */
  readonly skipped: boolean;
}

export class PostTaskCheckUseCase {
  constructor(
    private readonly external: ExternalPort,
    private readonly logger: LoggerPort
  ) {}

  async execute(input: PostTaskCheckInput): Promise<Result<PostTaskCheckOutput, DomainError>> {
    const log = this.logger.child({ projectPath: input.projectPath });

    if (input.changedFilesSinceBaseline?.length === 0) {
      log.debug('post-task check skipped (no changed files)');
      return Promise.resolve(Result.ok({ passed: true, output: '', skipped: true }));
    }

    log.info('running post-task check', { script: input.checkScript });
    const result = await this.external.runCheckScript(
      input.projectPath,
      input.checkScript,
      'post-task',
      input.timeoutMs
    );

    if (!result.passed) {
      log.warn('post-task check failed');
    }

    return Result.ok({
      passed: result.passed,
      output: result.output,
      skipped: false,
    });
  }
}
