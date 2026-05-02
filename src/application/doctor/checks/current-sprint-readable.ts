/**
 * `currentSprintReadableCheck` — confirms the configured `currentSprint`
 * id resolves to a readable, valid sprint on disk.
 *
 *  - No `currentSprint` set → `skip` (a fresh install has none).
 *  - `currentSprint` set + sprint loads cleanly → `pass`.
 *  - `currentSprint` set + sprint missing or invalid → `fail` with the
 *    repository's error message.
 */
import type { SprintRepository } from '@src/domain/repositories/sprint-repository.ts';
import type { ConfigStorePort } from '@src/application/config/config-store-port.ts';
import type { DoctorCheckResult } from '@src/application/doctor/run-doctor.ts';

export interface CurrentSprintReadableCheckDeps {
  readonly configStore: ConfigStorePort;
  readonly sprintRepo: SprintRepository;
}

export async function currentSprintReadableCheck(deps: CurrentSprintReadableCheckDeps): Promise<DoctorCheckResult> {
  const loaded = await deps.configStore.load();
  if (!loaded.ok) {
    return {
      name: 'Current sprint',
      status: 'fail',
      message: `failed to load config: ${loaded.error.message}`,
    };
  }
  const sprintId = loaded.value.currentSprint;
  if (sprintId === null) {
    return {
      name: 'Current sprint',
      status: 'skip',
      message: 'no current sprint set',
    };
  }

  const sprintR = await deps.sprintRepo.findById(sprintId);
  if (!sprintR.ok) {
    return {
      name: 'Current sprint',
      status: 'fail',
      message: `sprint ${sprintId} unreadable: ${sprintR.error.message}`,
    };
  }
  const sprint = sprintR.value;
  return {
    name: 'Current sprint',
    status: 'pass',
    message: `${sprint.name} (${sprint.status})`,
  };
}
