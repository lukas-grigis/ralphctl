/**
 * `resolveCurrentSprintId` — load the config and assert a current sprint
 * is set, returning its parsed `SprintId`.
 *
 * Today, ~11 CRUD views repeat the same 8-line prelude:
 *
 * ```ts
 * const config = await deps.configStore.load();
 * if (!config.ok) throw new Error(config.error.message);
 * const sprintIdStr = config.value.currentSprint;
 * if (!sprintIdStr) throw new Error('No current sprint. Set one via Settings.');
 * const idResult = SprintId.parse(sprintIdStr);
 * if (!idResult.ok) throw new Error(idResult.error.message);
 * ```
 *
 * This helper collapses that to one call with a uniform error + hint.
 * Migration of all call sites is a follow-up — this file just lands the
 * seam.
 *
 * Returns `Result.error(InvalidStateError)` when no current sprint is set
 * or when the persisted id is malformed; otherwise the parsed `SprintId`.
 */
import type { ConfigStorePort } from '@src/application/config/config-store-port.ts';
import { InvalidStateError } from '@src/domain/errors/invalid-state-error.ts';
import { Result } from '@src/domain/result.ts';
import { SprintId } from '@src/domain/values/sprint-id.ts';

const ATTEMPTED_ACTION = 'use-current-sprint';

export async function resolveCurrentSprintId(
  configStore: ConfigStorePort
): Promise<Result<SprintId, InvalidStateError>> {
  const config = await configStore.load();
  if (!config.ok) {
    return Result.error(
      new InvalidStateError({
        entity: 'sprint',
        currentState: 'unreadable-config',
        attemptedAction: ATTEMPTED_ACTION,
        message: `cannot resolve current sprint: ${config.error.message}`,
        hint: 'Run `ralphctl doctor` to diagnose the config file.',
      })
    );
  }

  const sprintIdStr = config.value.currentSprint;
  if (sprintIdStr === null) {
    return Result.error(
      new InvalidStateError({
        entity: 'sprint',
        currentState: 'none',
        attemptedAction: ATTEMPTED_ACTION,
        hint: 'Set one via Settings or `ralphctl sprint set-current`.',
      })
    );
  }

  const parsed = SprintId.parse(sprintIdStr);
  if (!parsed.ok) {
    return Result.error(
      new InvalidStateError({
        entity: 'sprint',
        currentState: 'invalid-id',
        attemptedAction: ATTEMPTED_ACTION,
        message: `persisted current sprint id is malformed: ${parsed.error.message}`,
        hint: 'Run `ralphctl doctor` or set a valid sprint via Settings.',
      })
    );
  }

  return Result.ok(parsed.value);
}
