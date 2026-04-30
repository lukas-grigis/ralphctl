import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AbsolutePath } from '../../domain/values/absolute-path.ts';
import { createSharedDeps } from '../bootstrap/shared-deps.ts';
import { resolveStoragePaths, type StoragePaths } from '../runtime/storage-paths-resolver.ts';
import { runDoctor } from './run-doctor.ts';

function uniqueRoot(): AbsolutePath {
  return AbsolutePath.trustString(
    join(
      tmpdir(),
      `ralphctl-doctor-int-${String(process.pid)}-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`
    )
  );
}

describe('runDoctor (integration)', () => {
  let root: AbsolutePath;
  let storage: StoragePaths;

  beforeEach(() => {
    root = uniqueRoot();
    storage = resolveStoragePaths({ root });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('runs every check and returns a stable check order', async () => {
    const deps = await createSharedDeps({ storage });
    const report = await runDoctor(deps);
    const names = report.checks.map((c) => c.name);
    expect(names).toEqual([
      'Node.js version',
      'Git installed',
      'Git identity',
      'AI provider binary',
      'Data directory',
      'Project paths',
      'Onboarding status',
      'Current sprint',
    ]);
  });

  it('reports ok or warn on a fresh install (no fail)', async () => {
    const deps = await createSharedDeps({ storage });
    const report = await runDoctor(deps);
    // Fresh install: AI provider unset (skip), no projects (skip), no
    // current sprint (skip). Pass: node, git, data dir. Warn possible
    // on git identity in CI.
    expect(report.status).not.toBe('fail');
  });
});
