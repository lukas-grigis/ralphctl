import type { Logger } from '@src/business/observability/logger.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { AppendFile } from '@src/business/io/append-file.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { DistillLearningsDeps } from '@src/application/flows/_shared/memory/distill-learnings.ts';
import type { DistillStepOpts } from '@src/application/flows/_shared/memory/distill-step.ts';

/**
 * Narrow dependency contract for the close-sprint chain. The composition root constructs each
 * field from the integration layer and passes the bag to `createCloseSprintFlow`. Smaller than
 * `ReviewDeps` because there's no AI session, no shell script, no template, no file locker —
 * close is pure state machine + persistence.
 *
 * `distill` carries the optional pre-transition distill composition: the slim
 * {@link DistillLearningsDeps} plus the static {@link DistillStepOpts} (project + memory root +
 * sandbox + repository + AI settings). It is optional because the close path stays fully usable
 * without a project / memory context (e.g. a degenerate sprint with no resolvable repo); when
 * absent the flow simply skips the distill step.
 */
export interface CloseSprintDeps {
  readonly sprintRepo: SprintRepository;
  readonly clock: () => IsoTimestamp;
  readonly logger: Logger;
  /** Append adapter for the closing separator line on `<sprintDir>/progress.md`. */
  readonly appendFile: AppendFile;
  /** Absolute path to `<sprintDir>/progress.md` for the closing separator. */
  readonly progressFile: AbsolutePath;
  /** Pre-transition distill composition (deps + static opts). Absent → distill step is skipped. */
  readonly distill?: { readonly deps: DistillLearningsDeps; readonly opts: DistillStepOpts };
}
