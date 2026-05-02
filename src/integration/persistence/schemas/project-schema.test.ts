import { describe, expect, it } from 'vitest';

import { Project } from '@src/domain/entities/project.ts';
import { Repository } from '@src/domain/entities/repository.ts';
import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';
import { ProjectName } from '@src/domain/values/project-name.ts';
import { emptyProjectsFile, fromProject, projectJsonSchema, projectsFileSchema, toProject } from './project-schema.ts';

function makeProject(): Project {
  const name = ProjectName.parse('demo-project');
  if (!name.ok) throw name.error;
  const repo = Repository.create({
    path: AbsolutePath.trustString('/code/demo'),
    name: 'demo',
    checkScript: 'pnpm test',
    checkTimeout: 60_000,
  });
  if (!repo.ok) throw repo.error;
  const p = Project.create({
    name: name.value,
    displayName: 'Demo project',
    description: 'a demo',
    repositories: [repo.value],
  });
  if (!p.ok) throw p.error;
  return p.value;
}

describe('project-schema', () => {
  it('round-trips a project with one repository', () => {
    const original = makeProject();
    const json = fromProject(original);
    const parsed = projectJsonSchema.safeParse(json);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const back = toProject(parsed.data);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.value.name).toBe(original.name);
    expect(back.value.displayName).toBe(original.displayName);
    expect(back.value.repositories).toHaveLength(1);
    expect(back.value.repositories[0]?.checkScript).toBe('pnpm test');
    expect(back.value.repositories[0]?.checkTimeout).toBe(60_000);
  });

  it('round-trips a project with multiple repositories', () => {
    const name = ProjectName.parse('multi');
    if (!name.ok) throw name.error;
    const r1 = Repository.create({ path: AbsolutePath.trustString('/code/a') });
    const r2 = Repository.create({ path: AbsolutePath.trustString('/code/b') });
    if (!r1.ok || !r2.ok) throw new Error('setup');
    const p = Project.create({
      name: name.value,
      displayName: 'Multi',
      repositories: [r1.value, r2.value],
    });
    if (!p.ok) throw p.error;
    const back = toProject(projectJsonSchema.parse(fromProject(p.value)));
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.value.repositories).toHaveLength(2);
  });

  it('omits optional fields cleanly when absent', () => {
    const name = ProjectName.parse('clean');
    if (!name.ok) throw name.error;
    const r = Repository.create({ path: AbsolutePath.trustString('/code/c') });
    if (!r.ok) throw r.error;
    const p = Project.create({
      name: name.value,
      displayName: 'Clean',
      repositories: [r.value],
    });
    if (!p.ok) throw p.error;
    const json = fromProject(p.value);
    expect('description' in json).toBe(false);
    expect('checkScript' in (json.repositories[0] ?? {})).toBe(false);
  });

  it('emptyProjectsFile shape parses cleanly', () => {
    const empty = emptyProjectsFile();
    const r = projectsFileSchema.safeParse(empty);
    expect(r.success).toBe(true);
  });

  it('rejects unknown version on projects file', () => {
    const r = projectsFileSchema.safeParse({ version: 99, projects: [] });
    expect(r.success).toBe(false);
  });

  it('round-trips a repository with a setup script', () => {
    const name = ProjectName.parse('with-setup');
    if (!name.ok) throw name.error;
    const repo = Repository.create({
      path: AbsolutePath.trustString('/code/with-setup'),
      setupScript: 'pnpm install',
    });
    if (!repo.ok) throw repo.error;
    const p = Project.create({
      name: name.value,
      displayName: 'With Setup',
      repositories: [repo.value],
    });
    if (!p.ok) throw p.error;

    const json = fromProject(p.value);
    expect(json.repositories[0]?.setupScript).toBe('pnpm install');

    const back = toProject(projectJsonSchema.parse(json));
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.value.repositories[0]?.setupScript).toBe('pnpm install');
  });

  it('reads legacy JSON without setupScript field as undefined (backwards compat)', () => {
    const legacyJson = {
      name: 'legacy',
      displayName: 'Legacy',
      repositories: [
        {
          name: 'r',
          path: '/code/legacy',
          // no setupScript field
        },
      ],
    };
    const parsed = projectJsonSchema.safeParse(legacyJson);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const back = toProject(parsed.data);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.value.repositories[0]?.setupScript).toBeUndefined();
  });

  it('round-trips a repository with onboardedAt set', () => {
    const TS = IsoTimestamp.trustString('2026-04-29T12:00:00.000Z');
    const name = ProjectName.parse('with-onboarding');
    if (!name.ok) throw name.error;
    const repo = Repository.create({
      path: AbsolutePath.trustString('/code/onboarded'),
      onboardedAt: TS,
    });
    if (!repo.ok) throw repo.error;
    const p = Project.create({
      name: name.value,
      displayName: 'With Onboarding',
      repositories: [repo.value],
    });
    if (!p.ok) throw p.error;

    const json = fromProject(p.value);
    expect(json.repositories[0]?.onboardedAt).toBe(TS);

    const back = toProject(projectJsonSchema.parse(json));
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.value.repositories[0]?.onboardedAt).toBe(TS);
  });

  it('omits onboardedAt from JSON when null (clean output)', () => {
    const name = ProjectName.parse('no-onboarding');
    if (!name.ok) throw name.error;
    const repo = Repository.create({ path: AbsolutePath.trustString('/code/clean') });
    if (!repo.ok) throw repo.error;
    const p = Project.create({
      name: name.value,
      displayName: 'Clean',
      repositories: [repo.value],
    });
    if (!p.ok) throw p.error;
    const json = fromProject(p.value);
    expect('onboardedAt' in (json.repositories[0] ?? {})).toBe(false);
  });

  it('reads legacy JSON without onboardedAt as null (backwards compat)', () => {
    const legacyJson = {
      name: 'legacy-2',
      displayName: 'Legacy 2',
      repositories: [
        {
          name: 'r',
          path: '/code/legacy-2',
          // no onboardedAt field
        },
      ],
    };
    const parsed = projectJsonSchema.safeParse(legacyJson);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const back = toProject(parsed.data);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.value.repositories[0]?.onboardedAt).toBeNull();
  });
});
