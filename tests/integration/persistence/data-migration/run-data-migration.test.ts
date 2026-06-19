/**
 * Unit test for the migration engine orchestrator. The engine bundles the three operations the
 * consent splash (Wave 2b) drives — `needsMigration` → `dryRun` → `apply` — behind one factory.
 * Nothing in the app calls it at runtime yet; this test pins the surface and proves the operations
 * are wired through to the real implementations.
 */

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { absolutePath } from '@tests/fixtures/domain.ts';
import { recordingWriteFile } from '@tests/fixtures/recording-write-file.ts';
import { createDataMigrationEngine } from '@src/integration/persistence/data-migration/run-data-migration.ts';
import { readDataVersion } from '@src/integration/persistence/data-migration/version-marker.ts';
import { freshId, seedLegacySprint } from '@tests/integration/persistence/data-migration/_seed.ts';

let appRoot: string;
let dataRoot: string;
let stateRoot: string;

beforeEach(async () => {
  appRoot = await fs.mkdtemp(join(tmpdir(), 'ralph-engine-'));
  dataRoot = join(appRoot, 'data');
  stateRoot = join(appRoot, 'state');
  await fs.mkdir(join(dataRoot, 'sprints'), { recursive: true });
  await fs.mkdir(join(stateRoot, 'locks'), { recursive: true });
});

afterEach(async () => {
  await fs.rm(appRoot, { recursive: true, force: true });
});

describe('createDataMigrationEngine', () => {
  it('threads needsMigration → dryRun → apply through to the real implementations', async () => {
    const engine = createDataMigrationEngine();
    const sid = freshId();
    await seedLegacySprint(dataRoot, sid, 'beta');

    expect(await engine.needsMigration(absolutePath(dataRoot))).toBe(true);

    const report = await engine.dryRun(absolutePath(dataRoot));
    expect(report.planned).toHaveLength(1);

    const result = await engine.apply(absolutePath(dataRoot), report, {
      timestamp: '2026-06-19T10:00:00.000Z',
      appVersion: '0.12.1',
      stateRoot: absolutePath(stateRoot),
      renderLearnings: () => undefined,
      writeFile: recordingWriteFile().fn,
    });
    expect(result.kind).toBe('ok');

    expect(await engine.needsMigration(absolutePath(dataRoot))).toBe(false);
    expect((await readDataVersion(absolutePath(dataRoot))).dataVersion).toBe(2);
  });
});
