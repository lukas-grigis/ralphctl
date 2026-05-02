import { rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import { Sprint } from '@src/domain/entities/sprint.ts';
import { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';
import { ProjectName } from '@src/domain/values/project-name.ts';
import { Slug } from '@src/domain/values/slug.ts';
import { DEFAULT_CHECK_TIMEOUT_MS } from '@src/integration/external/check-script-runner.ts';
import {
  resetEnsureLayoutDirsCache,
  resolveStoragePaths,
  type StoragePaths,
} from '@src/application/runtime/storage-paths-resolver.ts';
import { SessionManager } from '@src/application/runtime/session-manager.ts';
import { createSharedDeps, resolveCheckTimeoutMs } from './shared-deps.ts';

function uniqueRoot(): AbsolutePath {
  return AbsolutePath.trustString(
    join(tmpdir(), `ralphctl-deps-${String(process.pid)}-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`)
  );
}

describe('createSharedDeps', () => {
  let root: AbsolutePath;
  let storage: StoragePaths;

  beforeEach(() => {
    root = uniqueRoot();
    storage = resolveStoragePaths({ root });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('builds every port', async () => {
    const deps = await createSharedDeps({ storage });

    expect(deps.logger).toBeDefined();
    expect(deps.logsBus).toBeDefined();
    expect(deps.signalBus).toBeDefined();
    expect(deps.signalParser).toBeDefined();
    expect(deps.signalHandler).toBeDefined();
    expect(deps.aiSession).toBeDefined();
    expect(deps.prompts).toBeDefined();
    expect(deps.external).toBeDefined();
    expect(deps.sprintRepo).toBeDefined();
    expect(deps.projectRepo).toBeDefined();
    expect(deps.taskRepo).toBeDefined();
    expect(deps.configStore).toBeDefined();
    expect(deps.liveConfig).toBeDefined();
    expect(deps.skillsSyncer).toBeDefined();
    expect(deps.skillsLinker).toBeDefined();
    expect(deps.storage).toBe(storage);
    expect(deps.sessionId).toMatch(/^[a-z0-9]{8}$/);
    expect(deps.sessionManager).toBeDefined();
    expect(deps.sessionManager).toBeInstanceOf(SessionManager);

    await deps.sessionManager.dispose();
  });

  it('returns fresh objects across calls', async () => {
    const a = await createSharedDeps({ storage });
    const b = await createSharedDeps({ storage });
    expect(a).not.toBe(b);
    expect(a.signalBus).not.toBe(b.signalBus);
    expect(a.sessionId).not.toBe(b.sessionId);
    expect(a.sessionManager).not.toBe(b.sessionManager);

    await a.sessionManager.dispose();
    await b.sessionManager.dispose();
  });

  it('honors overrides', async () => {
    const customSessionId = 'fixedid1';
    const deps = await createSharedDeps({
      storage,
      sessionId: customSessionId,
      logSink: 'json',
    });
    expect(deps.sessionId).toBe(customSessionId);
  });

  it('configStore loads defaults on a fresh install', async () => {
    const deps = await createSharedDeps({ storage });
    const r = await deps.configStore.load();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.aiProvider).toBeNull();
      expect(r.value.evaluationIterations).toBe(1);
    }
  });

  it('liveConfig reads through the configStore', async () => {
    const deps = await createSharedDeps({ storage });
    const cfg = await deps.liveConfig.current();
    expect(cfg.evaluationIterations).toBe(1);
    expect(cfg.aiProvider).toBeNull();
  });

  it('does not eagerly create layout directories — only on first write', async () => {
    // Forget any prior memo so this test starts clean for `storage.root`.
    resetEnsureLayoutDirsCache();
    const deps = await createSharedDeps({ storage });

    // Read-only commands (`--version`, `--help`, `completion show`) reach
    // `createSharedDeps` but never write — the directory tree must stay
    // missing on disk.
    await expect(stat(storage.configDir)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(storage.sprintsDir)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(storage.cacheDir)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(storage.logsDir)).rejects.toMatchObject({ code: 'ENOENT' });

    // Trigger a write — first save must materialise the layout.
    const slug = Slug.parse('lazy');
    if (!slug.ok) throw slug.error;
    const projectName = ProjectName.parse('demo');
    if (!projectName.ok) throw projectName.error;
    const sprint = Sprint.create({
      name: 'Lazy',
      slug: slug.value,
      now: IsoTimestamp.trustString('2026-04-29T00:00:00.000Z'),
      projectName: projectName.value,
    });
    if (!sprint.ok) throw sprint.error;
    const saved = await deps.sprintRepo.save(sprint.value);
    expect(saved.ok).toBe(true);

    for (const d of [storage.configDir, storage.sprintsDir, storage.cacheDir, storage.logsDir, storage.backupsDir]) {
      const s = await stat(d);
      expect(s.isDirectory()).toBe(true);
    }

    await deps.sessionManager.dispose();
  });
});

describe('resolveCheckTimeoutMs', () => {
  // Legacy-parity intent: the harness has historically honored
  // RALPHCTL_SETUP_TIMEOUT_MS for slow / monorepo check scripts. Tests
  // pass an explicit env bag so we never mutate `process.env`.

  it('falls back to the runner default when the env var is unset', () => {
    expect(resolveCheckTimeoutMs({})).toBe(DEFAULT_CHECK_TIMEOUT_MS);
  });

  it('falls back when the env var is empty / whitespace', () => {
    expect(resolveCheckTimeoutMs({ RALPHCTL_SETUP_TIMEOUT_MS: '' })).toBe(DEFAULT_CHECK_TIMEOUT_MS);
    expect(resolveCheckTimeoutMs({ RALPHCTL_SETUP_TIMEOUT_MS: '   ' })).toBe(DEFAULT_CHECK_TIMEOUT_MS);
  });

  it('parses a valid positive integer override', () => {
    expect(resolveCheckTimeoutMs({ RALPHCTL_SETUP_TIMEOUT_MS: '600000' })).toBe(600_000);
  });

  it('falls back when the value is not a positive integer', () => {
    // A typo / negative / NaN value must not disable the timeout outright.
    expect(resolveCheckTimeoutMs({ RALPHCTL_SETUP_TIMEOUT_MS: '0' })).toBe(DEFAULT_CHECK_TIMEOUT_MS);
    expect(resolveCheckTimeoutMs({ RALPHCTL_SETUP_TIMEOUT_MS: '-1' })).toBe(DEFAULT_CHECK_TIMEOUT_MS);
    expect(resolveCheckTimeoutMs({ RALPHCTL_SETUP_TIMEOUT_MS: 'abc' })).toBe(DEFAULT_CHECK_TIMEOUT_MS);
  });
});
