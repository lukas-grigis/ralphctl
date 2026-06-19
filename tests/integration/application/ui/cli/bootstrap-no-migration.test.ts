/**
 * CLI bootstrap must NOT run (or offer) the data migration (Wave 2b). CLI one-shots can run headless
 * (CI / pipes) and the migration is gated on explicit interactive consent — the TUI owns it. We prove
 * the CLI never mutates the layout by pointing it at an un-migrated (legacy, no version-marker) data
 * tree and asserting that, after bootstrap, the version marker is still ABSENT and a legacy bare-id
 * sprint dir was left untouched (no rename to `<id>--<slug>`).
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapCli } from '@src/application/ui/cli/bootstrap.ts';
import { DATA_VERSION_FILENAME } from '@src/integration/persistence/data-migration/version-marker.ts';
import { RALPHCTL_HOME_ENV } from '@src/application/bootstrap/storage-paths.ts';

const exists = async (p: string): Promise<boolean> => {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
};

describe('cli bootstrap — no migration path', () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'ralphctl-cli-boot-'));
    prevHome = process.env[RALPHCTL_HOME_ENV];
    process.env[RALPHCTL_HOME_ENV] = home;
    // Seed a LEGACY, un-migrated data tree: a bare-id sprint dir and NO version marker (absent ⇒ v1).
    await fs.mkdir(join(home, 'data', 'sprints', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'), { recursive: true });
  });

  afterEach(async () => {
    if (prevHome === undefined) delete process.env[RALPHCTL_HOME_ENV];
    else process.env[RALPHCTL_HOME_ENV] = prevHome;
    await rm(home, { recursive: true, force: true });
  });

  it('leaves the version marker absent and the legacy tree unrenamed', async () => {
    const boot = await bootstrapCli();
    expect(boot.deps).toBeDefined();

    const markerPath = join(home, 'data', DATA_VERSION_FILENAME);
    expect(await exists(markerPath)).toBe(false);

    // The legacy bare-id dir is still there; no `<id>--<slug>` rename happened.
    const sprints = await fs.readdir(join(home, 'data', 'sprints'));
    expect(sprints).toContain('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(sprints.some((n) => n.includes('--'))).toBe(false);
  });
});
