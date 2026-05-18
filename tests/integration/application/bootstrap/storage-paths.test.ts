import { promises as fs } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  APP_ROOT_DIR,
  CONFIG_SUBDIR,
  DATA_SUBDIR,
  ensureStorageRoots,
  LOCKS_SUBDIR,
  RALPHCTL_HOME_ENV,
  resolveStoragePaths,
  RUNS_SUBDIR,
  STATE_SUBDIR,
} from '@src/application/bootstrap/storage-paths.ts';

describe('resolveStoragePaths', () => {
  it('resolves <home>/.ralphctl with data, config, state, and locks subdirs', () => {
    const result = resolveStoragePaths({ homedir: () => '/home/alice', env: {} });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(String(result.value.appRoot)).toBe('/home/alice/.ralphctl');
    expect(String(result.value.dataRoot)).toBe('/home/alice/.ralphctl/data');
    expect(String(result.value.configRoot)).toBe('/home/alice/.ralphctl/config');
    expect(String(result.value.stateRoot)).toBe('/home/alice/.ralphctl/state');
    expect(String(result.value.locksRoot)).toBe('/home/alice/.ralphctl/state/locks');
    expect(String(result.value.runsRoot)).toBe('/home/alice/.ralphctl/data/runs');
  });

  it('uses os.homedir() by default', () => {
    const result = resolveStoragePaths({ env: {} });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(String(result.value.appRoot)).toContain(APP_ROOT_DIR);
    expect(String(result.value.dataRoot)).toContain(`${APP_ROOT_DIR}/${DATA_SUBDIR}`);
    expect(String(result.value.configRoot)).toContain(`${APP_ROOT_DIR}/${CONFIG_SUBDIR}`);
    expect(String(result.value.stateRoot)).toContain(`${APP_ROOT_DIR}/${STATE_SUBDIR}`);
    expect(String(result.value.locksRoot)).toContain(`${STATE_SUBDIR}/${LOCKS_SUBDIR}`);
    expect(String(result.value.runsRoot)).toContain(`${DATA_SUBDIR}/${RUNS_SUBDIR}`);
  });

  it('returns ValidationError when homedir is not absolute', () => {
    const result = resolveStoragePaths({ homedir: () => 'relative/path', env: {} });
    expect(result.ok).toBe(false);
  });

  it('honours RALPHCTL_HOME env override when set to an absolute path', () => {
    const result = resolveStoragePaths({
      homedir: () => '/home/should-be-ignored',
      env: { [RALPHCTL_HOME_ENV]: '/var/lib/ralphctl-test' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(String(result.value.appRoot)).toBe('/var/lib/ralphctl-test');
    expect(String(result.value.dataRoot)).toBe('/var/lib/ralphctl-test/data');
    expect(String(result.value.locksRoot)).toBe('/var/lib/ralphctl-test/state/locks');
  });

  it('falls back to homedir layout when RALPHCTL_HOME is empty', () => {
    const result = resolveStoragePaths({
      homedir: () => '/home/alice',
      env: { [RALPHCTL_HOME_ENV]: '' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(String(result.value.appRoot)).toBe('/home/alice/.ralphctl');
  });

  it('returns ValidationError when RALPHCTL_HOME is set to a relative path', () => {
    const result = resolveStoragePaths({
      homedir: () => '/home/alice',
      env: { [RALPHCTL_HOME_ENV]: 'relative/path' },
    });
    expect(result.ok).toBe(false);
  });
});

describe('ensureStorageRoots', () => {
  let fakeHome: string;

  beforeEach(async () => {
    const raw = await fs.mkdtemp(join(tmpdir(), 'ralphctl-bootstrap-'));
    fakeHome = await realpath(raw);
  });

  afterEach(async () => {
    await fs.rm(fakeHome, { recursive: true, force: true });
  });

  it('creates the full directory tree on a fresh home', async () => {
    const paths = resolveStoragePaths({ homedir: () => fakeHome, env: {} });
    if (!paths.ok) throw new Error('resolveStoragePaths failed');

    const result = await ensureStorageRoots(paths.value);
    expect(result.ok).toBe(true);

    const expected = [
      `${fakeHome}/.ralphctl`,
      `${fakeHome}/.ralphctl/data`,
      `${fakeHome}/.ralphctl/config`,
      `${fakeHome}/.ralphctl/state`,
      `${fakeHome}/.ralphctl/state/locks`,
      `${fakeHome}/.ralphctl/data/projects`,
      `${fakeHome}/.ralphctl/data/sprints`,
      `${fakeHome}/.ralphctl/data/runs`,
    ];
    for (const dir of expected) {
      const stat = await fs.stat(dir);
      expect(stat.isDirectory()).toBe(true);
    }
  });

  it('is idempotent — running twice does not fail or duplicate work', async () => {
    const paths = resolveStoragePaths({ homedir: () => fakeHome, env: {} });
    if (!paths.ok) throw new Error('resolveStoragePaths failed');

    const first = await ensureStorageRoots(paths.value);
    const second = await ensureStorageRoots(paths.value);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
  });

  it('preserves pre-existing files inside the tree', async () => {
    const paths = resolveStoragePaths({ homedir: () => fakeHome, env: {} });
    if (!paths.ok) throw new Error('resolveStoragePaths failed');
    await ensureStorageRoots(paths.value);

    const existing = `${String(paths.value.dataRoot)}/projects/keep-me.json`;
    await fs.writeFile(existing, '{"keep":true}');

    const result = await ensureStorageRoots(paths.value);
    expect(result.ok).toBe(true);
    const content = await fs.readFile(existing, 'utf8');
    expect(content).toBe('{"keep":true}');
  });
});
