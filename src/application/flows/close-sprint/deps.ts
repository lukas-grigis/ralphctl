import type { Logger } from '@src/business/observability/logger.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { AppendFile } from '@src/business/io/append-file.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';

/**
 * Narrow dependency contract for the close-sprint chain. The composition root constructs each
 * field from the integration layer and passes the bag to `createCloseSprintFlow`. Smaller than
 * `ReviewDeps` because there's no AI session, no shell script, no template, no file locker —
 * close is pure state machine + persistence.
 */
export interface CloseSprintDeps {
  readonly sprintRepo: SprintRepository;
  readonly clock: () => IsoTimestamp;
  readonly logger: Logger;
  /** Append adapter for the closing separator line on `<sprintDir>/progress.md`. */
  readonly appendFile: AppendFile;
  /** Absolute path to `<sprintDir>/progress.md` for the closing separator. */
  readonly progressFile: AbsolutePath;
}
