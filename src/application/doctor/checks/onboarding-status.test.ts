import { describe, expect, it } from 'vitest';

import { InMemoryProjectRepository } from '../../../business/_test-fakes/in-memory-project-repository.ts';
import { Project } from '../../../domain/entities/project.ts';
import { Repository } from '../../../domain/entities/repository.ts';
import { AbsolutePath } from '../../../domain/values/absolute-path.ts';
import { IsoTimestamp } from '../../../domain/values/iso-timestamp.ts';
import { ProjectName } from '../../../domain/values/project-name.ts';
import { onboardingStatusCheck } from './onboarding-status.ts';

const TS = IsoTimestamp.trustString('2026-04-29T12:00:00.000Z');

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
  it('returns skip when there are no registered projects', async () => {
    const r = await onboardingStatusCheck({ projectRepo: new InMemoryProjectRepository() });
    expect(r.status).toBe('skip');
    expect(r.message).toBe('no projects registered');
  });

  it('returns pass when every repo is onboarded', async () => {
    const p = buildProject('demo', [makeRepo('/code/a', { onboarded: true })]);
    const r = await onboardingStatusCheck({ projectRepo: new InMemoryProjectRepository([p]) });
    expect(r.status).toBe('pass');
    expect(r.message).toMatch(/1\/1 repo onboarded/);
  });

  it('returns warn when at least one repo lacks onboardedAt', async () => {
    const p = buildProject('multi', [makeRepo('/code/a', { onboarded: true }), makeRepo('/code/b')]);
    const r = await onboardingStatusCheck({ projectRepo: new InMemoryProjectRepository([p]) });
    expect(r.status).toBe('warn');
    expect(r.message).toContain('multi/b');
  });

  it('returns warn for legacy data with no onboardedAt across all repos', async () => {
    const p = buildProject('legacy', [makeRepo('/code/a'), makeRepo('/code/b')]);
    const r = await onboardingStatusCheck({ projectRepo: new InMemoryProjectRepository([p]) });
    expect(r.status).toBe('warn');
    expect(r.message).toContain('2 repos not onboarded');
  });
});
