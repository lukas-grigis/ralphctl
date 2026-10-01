/** Sprint-id resolution for CLI commands — explicit argument first, pinned selection second. */

import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { Result } from '@src/domain/result.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { createLastSelectionStore } from '@src/integration/persistence/selection/last-selection-store.ts';

export interface ResolvedSprintId {
  readonly sprintId: SprintId;
  /** True when the id came from the pinned selection rather than an explicit argument. */
  readonly fromPin: boolean;
}

const DEFAULT_MISSING_MESSAGE =
  'no sprint specified — pass --sprint <id> or pin one with `ralphctl sprint set-current <id>`';

export interface ResolveSprintIdOptions {
  /**
   * Guidance emitted when neither an explicit id nor a pin exists. Defaults to the `--sprint <id>` phrasing; commands
   * with a positional `[id]` pass their own wording.
   */
  readonly missingMessage?: string;
}

const invalidId = (value: unknown, detail: string): ValidationError =>
  // Keep the long-established `invalid sprint id: …` stderr phrasing every command printed
  // before this helper existed — scripts (and the e2e suite) match on it.
  new ValidationError({ field: 'sprint-id', value, message: `invalid sprint id: ${detail}` });

export const resolveSprintId = async (
  raw: string | undefined,
  stateRoot: AbsolutePath,
  opts: ResolveSprintIdOptions = {}
): Promise<Result<ResolvedSprintId, DomainError>> => {
  if (raw !== undefined) {
    const parsed = SprintId.parse(raw);
    if (!parsed.ok) return Result.error(invalidId(raw, parsed.error.message));
    return Result.ok({ sprintId: parsed.value, fromPin: false });
  }
  const pinned = (await createLastSelectionStore(stateRoot).read())?.sprintId;
  if (pinned === undefined) {
    return Result.error(
      new ValidationError({
        field: 'sprint',
        value: undefined,
        message: opts.missingMessage ?? DEFAULT_MISSING_MESSAGE,
      })
    );
  }
  const parsed = SprintId.parse(String(pinned));
  if (!parsed.ok) return Result.error(invalidId(pinned, `${parsed.error.message} (from the pinned selection)`));
  return Result.ok({ sprintId: parsed.value, fromPin: true });
};

/**
 * One-line stderr notice for the fallback path — tells the user which sprint was substituted and how to override it,
 * so a stale pin never silently targets the wrong sprint.
 */
export const pinFallbackNotice = (id: SprintId): string =>
  `using current sprint ${String(id)} (from sprint set-current; pass --sprint to override)\n`;
