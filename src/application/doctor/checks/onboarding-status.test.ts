import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Config } from '@src/application/config/config.ts';
import { CONFIG_DEFAULTS } from '@src/application/config/config-defaults.ts';
import type { ConfigStorePort } from '@src/application/config/config-store-port.ts';
import { InMemoryProjectRepository } from '@src/business/_test-fakes/in-memory-project-repository.ts';
import { Project } from '@src/domain/entities/project.ts';
import { Repository } from '@src/domain/entities/repository.ts';
import type { StorageError } from '@src/domain/errors/storage-error.ts';
import { Result } from '@src/domain/result.ts';
import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';
import { ProjectName } from '@src/domain/values/project-name.ts';
import { onboardingStatusCheck } from './onboarding-status.ts';

const TS = IsoTimestamp.trustString('2026-04-29T12:00:00.000Z');

class FakeConfigStore implements ConfigStorePort {
  constructor(private readonly cfg: Config = CONFIG_DEFAULTS) {}
  load(): Promise<Result<Config, StorageError>> {
    return Promise.resolve(Result.ok(this.cfg));
  }
  save(): Promise<Result<void, StorageError>> {
    return Promise.resolve(Result.ok());
  }
}

function buildProject(name: string, repos: readonly Repository[]): Project {
  const pn = ProjectName.parse(name);
  if (!pn.ok) throw pn.error;
  const p = Project.create({
    name: pn.value,
    displayName: name,
    repositories: repos,
  });
  if (!p.ok) throw p.error;
  return p.value;
}

function makeRepo(p: string, opts: { onboarded?: boolean } = {}): Repository {
  const r = Repository.create({
    path: AbsolutePath.trustString(p),
    ...(opts.onboarded ? { onboardedAt: TS } : {}),
  });
  if (!r.ok) throw r.error;
  return r.value;
}

describe('onboardingStatusCheck', () => {
  const tmpdirs: string[] = [];

  async function mkRepoDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'ralphctl-onboarding-status-'));
    tmpdirs.push(dir);
    return dir;
  }

  beforeEach(() => {
    tmpdirs.length = 0;
  });

  afterEach(async () => {
    // Best-effort cleanup; doctor probes never write inside the repo so
    // tearing the dirs down is straight-forward.
    const { rm } = await import('node:fs/promises');
    for (const d of tmpdirs) {
      await rm(d, { recursive: true, force: true });
    }
  });

  it('returns skip when there are no registered projects', async () => {
    const r = await onboardingStatusCheck({
      projectRepo: new InMemoryProjectRepository(),
      configStore: new FakeConfigStore(),
    });
    expect(r.status).toBe('skip');
    expect(r.message).toBe('no projects registered');
  });

  it('returns pass when every repo has onboardedAt set (ralphctl-managed)', async () => {
    const repoDir = await mkRepoDir();
    const p = buildProject('demo', [makeRepo(repoDir, { onboarded: true })]);
    const r = await onboardingStatusCheck({
      projectRepo: new InMemoryProjectRepository([p]),
      configStore: new FakeConfigStore(),
    });
    expect(r.status).toBe('pass');
    expect(r.message).toMatch(/1\/1 repo onboarded/);
  });

  it('treats CLAUDE.md with the harness marker as ralphctl-managed', async () => {
    const repoDir = await mkRepoDir();
    await writeFile(
      join(repoDir, 'CLAUDE.md'),
      '<!-- ralphctl onboard: 2026-04-29T12:00:00Z -->\n# Project context\n',
      'utf-8'
    );
    const p = buildProject('demo', [makeRepo(repoDir)]);
    const r = await onboardingStatusCheck({
      projectRepo: new InMemoryProjectRepository([p]),
      configStore: new FakeConfigStore({ ...CONFIG_DEFAULTS, aiProvider: 'claude' }),
    });
    expect(r.status).toBe('pass');
    expect(r.message).toMatch(/1\/1 repo onboarded/);
  });

  it('treats hand-authored CLAUDE.md (no marker) as self-managed', async () => {
    const repoDir = await mkRepoDir();
    await writeFile(join(repoDir, 'CLAUDE.md'), '# Hand-authored project context\n', 'utf-8');
    const p = buildProject('demo', [makeRepo(repoDir)]);
    const r = await onboardingStatusCheck({
      projectRepo: new InMemoryProjectRepository([p]),
      configStore: new FakeConfigStore({ ...CONFIG_DEFAULTS, aiProvider: 'claude' }),
    });
    expect(r.status).toBe('pass');
    expect(r.message).toContain('self-managed');
    expect(r.message).toContain('1 repo configured');
  });

  it('returns warn when no provider-native context file exists', async () => {
    const repoDir = await mkRepoDir();
    const p = buildProject('demo', [makeRepo(repoDir)]);
    const r = await onboardingStatusCheck({
      projectRepo: new InMemoryProjectRepository([p]),
      configStore: new FakeConfigStore({ ...CONFIG_DEFAULTS, aiProvider: 'claude' }),
    });
    expect(r.status).toBe('warn');
    expect(r.details).toStrictEqual(['demo/' + (p.repositories[0]?.name ?? '')]);
    expect(r.message).toContain('1/1 repo not onboarded');
  });

  it('mixed case: lists only the missing repo, ignores self-managed and ralphctl-managed', async () => {
    const selfDir = await mkRepoDir();
    await writeFile(join(selfDir, 'CLAUDE.md'), '# Hand-authored\n', 'utf-8');
    const ralphDir = await mkRepoDir();
    await writeFile(join(ralphDir, 'CLAUDE.md'), '<!-- ralphctl onboard: 2026-04-29T12:00:00Z -->\n', 'utf-8');
    const missingDir = await mkRepoDir();

    const selfRepo = makeRepo(selfDir);
    const ralphRepo = makeRepo(ralphDir);
    const missingRepo = makeRepo(missingDir);
    const p = buildProject('multi', [selfRepo, ralphRepo, missingRepo]);

    const r = await onboardingStatusCheck({
      projectRepo: new InMemoryProjectRepository([p]),
      configStore: new FakeConfigStore({ ...CONFIG_DEFAULTS, aiProvider: 'claude' }),
    });
    expect(r.status).toBe('warn');
    expect(r.details).toStrictEqual([`multi/${missingRepo.name}`]);
    expect(r.message).toContain('1/3 repo');
  });

  it('falls back to checking both provider files when aiProvider is null', async () => {
    const repoDir = await mkRepoDir();
    await mkdir(join(repoDir, '.github'), { recursive: true });
    await writeFile(join(repoDir, '.github', 'copilot-instructions.md'), '# Hand-authored\n', 'utf-8');
    const p = buildProject('demo', [makeRepo(repoDir)]);
    const r = await onboardingStatusCheck({
      projectRepo: new InMemoryProjectRepository([p]),
      configStore: new FakeConfigStore(), // aiProvider: null
    });
    expect(r.status).toBe('pass');
    expect(r.message).toContain('self-managed');
  });

  it('honours onboardedAt even when no context file exists on disk', async () => {
    // Persisted timestamp from a previous onboard run stays authoritative
    // — the file may have been moved/renamed but ralphctl recorded it.
    const repoDir = await mkRepoDir();
    const p = buildProject('legacy', [makeRepo(repoDir, { onboarded: true })]);
    const r = await onboardingStatusCheck({
      projectRepo: new InMemoryProjectRepository([p]),
      configStore: new FakeConfigStore({ ...CONFIG_DEFAULTS, aiProvider: 'claude' }),
    });
    expect(r.status).toBe('pass');
    expect(r.message).toMatch(/1\/1 repo onboarded/);
  });

  it('treats marker on first line with extensive trailing content as ralphctl-managed', async () => {
    // The harness writes the marker on line 1 and treats everything after
    // it as managed content. A long body below the marker is the normal
    // shape of a freshly-onboarded file — not hybrid.
    const repoDir = await mkRepoDir();
    const longBody =
      '<!-- ralphctl onboard: 2026-04-29T12:00:00Z -->\n' +
      '# Project context\n\n' +
      'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(50);
    await writeFile(join(repoDir, 'CLAUDE.md'), longBody, 'utf-8');
    const p = buildProject('demo', [makeRepo(repoDir)]);
    const r = await onboardingStatusCheck({
      projectRepo: new InMemoryProjectRepository([p]),
      configStore: new FakeConfigStore({ ...CONFIG_DEFAULTS, aiProvider: 'claude' }),
    });
    expect(r.status).toBe('pass');
    expect(r.message).toMatch(/1\/1 repo onboarded/);
  });

  it('treats marker with substantial preamble as hybrid', async () => {
    const repoDir = await mkRepoDir();
    // Comfortably above the 200 non-blank-char threshold — clearly a
    // hand-merged hybrid, not a stray title line.
    const preamble =
      '# My project\n\n' +
      'This document was authored by hand to capture domain context the harness ' +
      'does not generate automatically. It includes architectural notes, team ' +
      'conventions, and pointers to internal docs that pre-date ralphctl. ' +
      'The intent is to keep this prose intact across onboarding runs so future ' +
      'contributors do not lose institutional context when the harness rewrites.\n\n';
    await writeFile(
      join(repoDir, 'CLAUDE.md'),
      preamble + '<!-- ralphctl onboard: 2026-04-29T12:00:00Z -->\n# Harness section\n',
      'utf-8'
    );
    const p = buildProject('demo', [makeRepo(repoDir)]);
    const r = await onboardingStatusCheck({
      projectRepo: new InMemoryProjectRepository([p]),
      configStore: new FakeConfigStore({ ...CONFIG_DEFAULTS, aiProvider: 'claude' }),
    });
    expect(r.status).toBe('pass');
    expect(r.message).toContain('1 hybrid');
    expect(r.message).toContain('1 repo configured');
  });

  it('treats marker with manual content above AND below as hybrid', async () => {
    // Even though everything below the marker is "harness-managed" by
    // convention, the preamble alone is enough to flag the file.
    const repoDir = await mkRepoDir();
    const preamble =
      '# Custom prelude\n\n' +
      'A paragraph or two of carefully-curated context the user wants to keep ' +
      'across onboard runs. The harness should notice this so the next pass ' +
      'is not a surprise — that is the whole point of the hybrid state. ' +
      'We add a couple more sentences here to clear the threshold comfortably ' +
      'and avoid any flakiness around exact character counts in the heuristic.\n\n';
    const body =
      preamble +
      '<!-- ralphctl onboard: 2026-04-29T12:00:00Z -->\n' +
      '# Harness section\nMore harness-written content.\n';
    await writeFile(join(repoDir, 'CLAUDE.md'), body, 'utf-8');
    const p = buildProject('demo', [makeRepo(repoDir, { onboarded: true })]);
    const r = await onboardingStatusCheck({
      projectRepo: new InMemoryProjectRepository([p]),
      configStore: new FakeConfigStore({ ...CONFIG_DEFAULTS, aiProvider: 'claude' }),
    });
    expect(r.status).toBe('pass');
    expect(r.message).toContain('1 hybrid');
  });

  it('treats marker with only whitespace/blank lines around it as ralphctl-managed', async () => {
    const repoDir = await mkRepoDir();
    // A few blank lines / trailing whitespace before the marker is well
    // below the threshold — incidental, not a meaningful merge.
    await writeFile(
      join(repoDir, 'CLAUDE.md'),
      '\n\n   \n<!-- ralphctl onboard: 2026-04-29T12:00:00Z -->\n# Harness\n',
      'utf-8'
    );
    const p = buildProject('demo', [makeRepo(repoDir)]);
    const r = await onboardingStatusCheck({
      projectRepo: new InMemoryProjectRepository([p]),
      configStore: new FakeConfigStore({ ...CONFIG_DEFAULTS, aiProvider: 'claude' }),
    });
    expect(r.status).toBe('pass');
    expect(r.message).toMatch(/1\/1 repo onboarded/);
  });
});
