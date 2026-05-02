import { describe, expect, it } from 'vitest';

import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import type { StoragePaths } from '@src/application/runtime/storage-paths-resolver.ts';
import { sessionLogPathCheck } from './session-log-path.ts';

function makeStorage(): StoragePaths {
  const root = AbsolutePath.trustString('/tmp/ralphctl-doctor');
  const logsDir = AbsolutePath.trustString('/tmp/ralphctl-doctor/logs');
  return {
    root,
    configDir: AbsolutePath.trustString('/tmp/ralphctl-doctor/config'),
    dataDir: AbsolutePath.trustString('/tmp/ralphctl-doctor/data'),
    sprintsDir: AbsolutePath.trustString('/tmp/ralphctl-doctor/data/sprints'),
    cacheDir: AbsolutePath.trustString('/tmp/ralphctl-doctor/cache'),
    logsDir,
    backupsDir: AbsolutePath.trustString('/tmp/ralphctl-doctor/backups'),
    configFile: AbsolutePath.trustString('/tmp/ralphctl-doctor/config/config.json'),
    projectsFile: AbsolutePath.trustString('/tmp/ralphctl-doctor/config/projects.json'),
    sprintDir: () => AbsolutePath.trustString('/tmp/ralphctl-doctor/data/sprints/x'),
    sprintFile: () => AbsolutePath.trustString('/tmp/ralphctl-doctor/data/sprints/x/sprint.json'),
    tasksFile: () => AbsolutePath.trustString('/tmp/ralphctl-doctor/data/sprints/x/tasks.json'),
  };
}

describe('sessionLogPathCheck', () => {
  it('returns pass with the resolved log file path', async () => {
    const result = await sessionLogPathCheck({ storage: makeStorage(), sessionId: 'abc-123' });
    expect(result.status).toBe('pass');
    expect(result.name).toBe('Session log path');
    expect(result.message).toBe('/tmp/ralphctl-doctor/logs/abc-123.jsonl');
  });
});
