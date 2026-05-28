import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFsProjectRepository } from '@src/integration/persistence/project/repository.ts';
import { makeProject } from '@tests/fixtures/domain.ts';
import { createCliHome, runCliCaptured, type CliHome } from '@tests/e2e/cli/_harness.ts';

describe('ralphctl doctor', () => {
  let cli: CliHome;

  beforeEach(async () => {
    cli = await createCliHome();
  });

  afterEach(async () => cli.cleanup());

  it('reports the standard probe set on a fresh install — including a settings-persisted warning', async () => {
    const result = await runCliCaptured(cli, ['doctor']);
    // Exit code depends on whether the active provider's CLI is on PATH on the test runner —
    // we don't assert it. Provider-CLI presence is intentionally a hard fail when missing.
    expect(result.stdout).toContain('Data root readable');
    expect(result.stdout).toContain('Config root readable');
    expect(result.stdout).toContain('Settings file present');
    expect(result.stdout).toContain('Git installed');
    expect(result.stdout).toContain('GitHub CLI');
    expect(result.stdout).toContain('GitLab CLI');
    expect(result.stdout).toContain('Claude Code');
    expect(result.stdout).toContain('Project repository responds');
    expect(result.stdout).toContain('Sprint repository responds');
    // First-run warning surfaced as actionable hint.
    expect(result.stdout).toContain('WARN  Settings file present');
    expect(result.stdout).toContain('hint: open the welcome flow');
  });

  it('reflects seeded entities in the project + sprint probe details', async () => {
    const projectRepo = createFsProjectRepository({ root: cli.paths.dataRoot });
    await projectRepo.save(makeProject({ displayName: 'Demo' }));
    // Read-fence the save before invoking doctor. `writeJsonAtomic` lands the project via a
    // temp-file + rename, and the rename isn't guaranteed to be visible to a sibling reader
    // on the same event-loop turn on every platform — macOS `/var/folders` (with realpath
    // symlinks) and some Linux runners have surfaced this as an intermittent "0 project(s)"
    // failure. Listing here forces the file to be reachable before doctor reads the dir.
    const listed = await projectRepo.list();
    expect(listed.ok).toBe(true);

    const result = await runCliCaptured(cli, ['doctor']);
    expect(result.stdout).toContain('1 project(s)');
  });
});
