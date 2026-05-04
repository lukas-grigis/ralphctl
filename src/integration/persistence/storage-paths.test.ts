import { mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import { SprintId } from '@src/domain/values/sprint-id.ts';
import { ensureLayoutDirs, resolveStoragePaths } from './storage-paths.ts';

const sprintIdResult = SprintId.parse('20260429-141522-fixture');
if (!sprintIdResult.ok) throw sprintIdResult.error;
const FIXTURE_SPRINT = sprintIdResult.value;

function uniqueRoot(): AbsolutePath {
  const dir = join(
    tmpdir(),
    `ralphctl-paths-${String(process.pid)}-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`
  );
  return AbsolutePath.trustString(dir);
}

describe('resolveStoragePaths', () => {
  const originalEnv = process.env['RALPHCTL_ROOT'];

  afterEach(() => {
    if (originalEnv === undefined) delete process.env['RALPHCTL_ROOT'];
    else process.env['RALPHCTL_ROOT'] = originalEnv;
  });

  it('honours an explicit root option', () => {
    const root = uniqueRoot();
    const paths = resolveStoragePaths({ root });
    expect(paths.root).toBe(root);
    expect(paths.configDir).toBe(join(root, 'config'));
    expect(paths.dataDir).toBe(join(root, 'data'));
    expect(paths.sprintsDir).toBe(join(root, 'data', 'sprints'));
    expect(paths.cacheDir).toBe(join(root, 'cache'));
    expect(paths.logsDir).toBe(join(root, 'logs'));
    expect(paths.backupsDir).toBe(join(root, 'backups'));
    expect(paths.configFile).toBe(join(root, 'config', 'config.json'));
    expect(paths.projectsFile).toBe(join(root, 'config', 'projects.json'));
  });

  it('honours RALPHCTL_ROOT env override when no option provided', () => {
    const envRoot = uniqueRoot();
    process.env['RALPHCTL_ROOT'] = envRoot;
    const paths = resolveStoragePaths();
    expect(paths.root).toBe(envRoot);
    expect(paths.configFile.startsWith(envRoot)).toBe(true);
  });

  it('falls back to the home directory when no env var or option is provided', () => {
    delete process.env['RALPHCTL_ROOT'];
    const paths = resolveStoragePaths();
    expect(paths.root.endsWith('.ralphctl')).toBe(true);
  });

  it('formats sprintDir/sprintFile/tasksFile under sprintsDir', () => {
    const root = uniqueRoot();
    const paths = resolveStoragePaths({ root });
    expect(paths.sprintDir(FIXTURE_SPRINT)).toBe(join(paths.sprintsDir, FIXTURE_SPRINT));
    expect(paths.sprintFile(FIXTURE_SPRINT)).toBe(join(paths.sprintsDir, FIXTURE_SPRINT, 'sprint.json'));
    expect(paths.tasksFile(FIXTURE_SPRINT)).toBe(join(paths.sprintsDir, FIXTURE_SPRINT, 'tasks.json'));
  });

  it('formats per-unit folder paths under <sprintDir>/{refinement,ideation,planning,execution}/', () => {
    const root = uniqueRoot();
    const paths = resolveStoragePaths({ root });
    const sprintDir = paths.sprintDir(FIXTURE_SPRINT);
    expect(paths.refinementUnitDir(FIXTURE_SPRINT, 'tk1-foo')).toBe(join(sprintDir, 'refinement', 'tk1-foo'));
    expect(paths.ideationUnitDir(FIXTURE_SPRINT, 'tk1-foo')).toBe(join(sprintDir, 'ideation', 'tk1-foo'));
    expect(paths.planningDir(FIXTURE_SPRINT)).toBe(join(sprintDir, 'planning'));
    expect(paths.executionUnitDir(FIXTURE_SPRINT, 'task1-bar')).toBe(join(sprintDir, 'execution', 'task1-bar'));
  });

  it('formats sprint root files', () => {
    const root = uniqueRoot();
    const paths = resolveStoragePaths({ root });
    const sprintDir = paths.sprintDir(FIXTURE_SPRINT);
    expect(paths.progressFile(FIXTURE_SPRINT)).toBe(join(sprintDir, 'progress.md'));
    expect(paths.requirementsAggregateFile(FIXTURE_SPRINT)).toBe(join(sprintDir, 'requirements.json'));
    expect(paths.feedbackFile(FIXTURE_SPRINT)).toBe(join(sprintDir, 'feedback.md'));
  });

  it('does not perform I/O for per-unit path resolution', async () => {
    const root = uniqueRoot();
    const paths = resolveStoragePaths({ root });
    paths.refinementUnitDir(FIXTURE_SPRINT, 'tk1');
    paths.executionUnitDir(FIXTURE_SPRINT, 'task1');
    paths.planningDir(FIXTURE_SPRINT);
    // Resolution alone must not materialise any directory.
    await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('RALPHCTL_ROOT with trailing slash: trailing slash is preserved in root as-is (not stripped)', () => {
    // Document: the function does not strip trailing slashes. The env value is
    // trusted via trustString. Callers wanting normalisation must strip before setting.
    const envRoot = '/tmp/ralphctl-trailing/';
    process.env['RALPHCTL_ROOT'] = envRoot;
    const paths = resolveStoragePaths();
    // Root is taken verbatim from the env var.
    expect(paths.root).toBe(envRoot);
    // Sub-paths are computed via join(), which normalises the slash.
    expect(paths.configDir).toBe(join(envRoot, 'config'));
  });

  it('RALPHCTL_ROOT with ~/... prefix: tilde is NOT expanded (caller responsibility)', () => {
    // Document: trustString does not expand tilde. If a caller passes
    // RALPHCTL_ROOT=~/.ralphctl-test the stored root contains the literal tilde.
    // Home-dir expansion is the composition root's responsibility.
    const tildeRoot = '~/.ralphctl-test';
    process.env['RALPHCTL_ROOT'] = tildeRoot;
    const paths = resolveStoragePaths();
    expect(paths.root).toBe(tildeRoot);
    // Tilde is still in the sub-paths — no home expansion happened.
    expect(paths.configDir.startsWith('~')).toBe(true);
  });

  it('does not perform I/O on its own', async () => {
    const root = uniqueRoot();
    resolveStoragePaths({ root });
    // The directory must NOT exist after resolution alone.
    await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('ensureLayoutDirs', () => {
  let root: AbsolutePath;

  beforeEach(() => {
    root = uniqueRoot();
  });

  afterEach(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  });

  it('creates every layout directory idempotently', async () => {
    const paths = resolveStoragePaths({ root });
    await ensureLayoutDirs(paths);
    for (const d of [paths.configDir, paths.sprintsDir, paths.cacheDir, paths.logsDir, paths.backupsDir]) {
      const s = await stat(d);
      expect(s.isDirectory()).toBe(true);
    }
    // Run twice — must not throw on existing dirs.
    await ensureLayoutDirs(paths);
  });

  it('tolerates a pre-existing root directory', async () => {
    await mkdir(root, { recursive: true });
    const paths = resolveStoragePaths({ root });
    await ensureLayoutDirs(paths);
    const s = await stat(paths.configDir);
    expect(s.isDirectory()).toBe(true);
  });
});
