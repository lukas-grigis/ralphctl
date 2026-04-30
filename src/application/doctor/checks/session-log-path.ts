/**
 * `sessionLogPathCheck` — informational row that surfaces where the current
 * session's structured logs are written.
 *
 * The composition root constructs a `JsonlFileWriter` against
 * `<logsDir>/<sessionId>.jsonl`. Doctor surfaces the same path so users can
 * find their trace without having to read source code.
 *
 * Always returns `'pass'` — this is a hint, not a probe.
 */
import { join } from 'node:path';

import type { StoragePaths } from '../../runtime/storage-paths-resolver.ts';
import type { DoctorCheckResult } from '../run-doctor.ts';

export interface SessionLogPathCheckDeps {
  readonly storage: StoragePaths;
  readonly sessionId: string;
}

export function sessionLogPathCheck(deps: SessionLogPathCheckDeps): Promise<DoctorCheckResult> {
  const file = join(deps.storage.logsDir, `${deps.sessionId}.jsonl`);
  return Promise.resolve({
    name: 'Session log path',
    status: 'pass',
    message: file,
  });
}
