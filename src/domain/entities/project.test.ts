import { describe, expect, it } from 'vitest';

import { AbsolutePath } from '../values/absolute-path.ts';
import { IsoTimestamp } from '../values/iso-timestamp.ts';
import { ProjectName } from '../values/project-name.ts';
import { Project } from './project.ts';
import { Repository } from './repository.ts';

function name(): ProjectName {
  const r = ProjectName.parse('demo-project');
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

function path(p: string): AbsolutePath {
  const r = AbsolutePath.parse(p);
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

function repo(p: string, opts: { name?: string; script?: string } = {}): Repository {
  const r = Repository.create({ path: path(p), name: opts.name, checkScript: opts.script });
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

describe('Project.create', () => {
  it('builds a project with at least one repo', () => {
    const r = Project.create({
      name: name(),
      displayName: 'Demo',
      repositories: [repo('/abs/r1')],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.displayName).toBe('Demo');
    expect(r.value.repositories).toHaveLength(1);
    expect(r.value.description).toBeUndefined();
  });

  it('trims displayName + description', () => {
    const r = Project.create({
      name: name(),
      displayName: '  Demo  ',
      description: '  hello world  ',
      repositories: [repo('/abs/r1')],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.displayName).toBe('Demo');
    expect(r.value.description).toBe('hello world');
  });

  it('rejects empty displayName', () => {
    const r = Project.create({
      name: name(),
      displayName: '   ',
      repositories: [repo('/abs/r1')],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe('project.displayName');
  });

  it('rejects zero repositories', () => {
    const r = Project.create({ name: name(), displayName: 'Demo', repositories: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe('project.repositories');
  });

  it('rejects duplicate repository paths in the initial list', () => {
    const r = Project.create({
      name: name(),
      displayName: 'Demo',
      repositories: [repo('/abs/r1'), repo('/abs/r1', { name: 'alias' })],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain('/abs/r1');
  });
});

describe('Project.addRepository', () => {
  it('appends a new repository', () => {
    const p0 = Project.create({
      name: name(),
      displayName: 'Demo',
      repositories: [repo('/abs/r1')],
    });
    if (!p0.ok) throw new Error('precondition failed');
    const p1 = p0.value.addRepository(repo('/abs/r2'));
    expect(p1.ok).toBe(true);
    if (!p1.ok) return;
    expect(p1.value.repositories.map((r) => r.path)).toEqual(['/abs/r1', '/abs/r2']);
  });

  it('rejects duplicates with ConflictError', () => {
    const p0 = Project.create({
      name: name(),
      displayName: 'Demo',
      repositories: [repo('/abs/r1')],
    });
    if (!p0.ok) throw new Error('precondition failed');
    const p1 = p0.value.addRepository(repo('/abs/r1'));
    expect(p1.ok).toBe(false);
    if (!p1.ok) {
      expect(p1.error.code).toBe('conflict');
      expect(p1.error.conflictingId).toBe('/abs/r1');
    }
  });

  it('does not mutate the original repositories array', () => {
    const p0 = Project.create({
      name: name(),
      displayName: 'Demo',
      repositories: [repo('/abs/r1')],
    });
    if (!p0.ok) throw new Error('precondition failed');
    const before = p0.value.repositories;
    p0.value.addRepository(repo('/abs/r2'));
    expect(p0.value.repositories).toBe(before);
    expect(p0.value.repositories).toHaveLength(1);
  });
});

describe('Project.removeRepository', () => {
  it('removes a non-last repository', () => {
    const p0 = Project.create({
      name: name(),
      displayName: 'Demo',
      repositories: [repo('/abs/r1'), repo('/abs/r2')],
    });
    if (!p0.ok) throw new Error('precondition failed');
    const p1 = p0.value.removeRepository(path('/abs/r1'));
    expect(p1.ok).toBe(true);
    if (!p1.ok) return;
    expect(p1.value.repositories.map((r) => r.path)).toEqual(['/abs/r2']);
  });

  it('refuses to remove the last repository', () => {
    const p0 = Project.create({
      name: name(),
      displayName: 'Demo',
      repositories: [repo('/abs/r1')],
    });
    if (!p0.ok) throw new Error('precondition failed');
    const r = p0.value.removeRepository(path('/abs/r1'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain('at least one');
  });

  it('errors when the path is not registered', () => {
    const p0 = Project.create({
      name: name(),
      displayName: 'Demo',
      repositories: [repo('/abs/r1'), repo('/abs/r2')],
    });
    if (!p0.ok) throw new Error('precondition failed');
    const r = p0.value.removeRepository(path('/abs/missing'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain('not found');
  });
});

describe('Project.updateRepository', () => {
  it('updates the check script in place', () => {
    const p0 = Project.create({
      name: name(),
      displayName: 'Demo',
      repositories: [repo('/abs/r1')],
    });
    if (!p0.ok) throw new Error('precondition failed');
    const p1 = p0.value.updateRepository(path('/abs/r1'), { checkScript: 'pnpm test' });
    expect(p1.ok).toBe(true);
    if (!p1.ok) return;
    expect(p1.value.repositories[0]?.checkScript).toBe('pnpm test');
  });

  it('clears the check script when undefined is passed explicitly', () => {
    const p0 = Project.create({
      name: name(),
      displayName: 'Demo',
      repositories: [repo('/abs/r1', { script: 'pnpm test' })],
    });
    if (!p0.ok) throw new Error('precondition failed');
    const p1 = p0.value.updateRepository(path('/abs/r1'), { checkScript: undefined });
    expect(p1.ok).toBe(true);
    if (!p1.ok) return;
    expect(p1.value.repositories[0]?.checkScript).toBeUndefined();
  });

  it('updates the timeout', () => {
    const p0 = Project.create({
      name: name(),
      displayName: 'Demo',
      repositories: [repo('/abs/r1')],
    });
    if (!p0.ok) throw new Error('precondition failed');
    const p1 = p0.value.updateRepository(path('/abs/r1'), { checkTimeout: 60_000 });
    expect(p1.ok).toBe(true);
    if (p1.ok) expect(p1.value.repositories[0]?.checkTimeout).toBe(60_000);
  });

  it('updates the name', () => {
    const p0 = Project.create({
      name: name(),
      displayName: 'Demo',
      repositories: [repo('/abs/r1')],
    });
    if (!p0.ok) throw new Error('precondition failed');
    const p1 = p0.value.updateRepository(path('/abs/r1'), { name: 'renamed' });
    expect(p1.ok).toBe(true);
    if (p1.ok) expect(p1.value.repositories[0]?.name).toBe('renamed');
  });

  it('errors when the path is not registered', () => {
    const p0 = Project.create({
      name: name(),
      displayName: 'Demo',
      repositories: [repo('/abs/r1')],
    });
    if (!p0.ok) throw new Error('precondition failed');
    const r = p0.value.updateRepository(path('/abs/missing'), { checkScript: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain('not found');
  });

  it('propagates validation errors from the nested entity', () => {
    const p0 = Project.create({
      name: name(),
      displayName: 'Demo',
      repositories: [repo('/abs/r1')],
    });
    if (!p0.ok) throw new Error('precondition failed');
    const r = p0.value.updateRepository(path('/abs/r1'), { checkTimeout: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe('repository.checkTimeout');
  });

  it('sets onboardedAt via updateRepository', () => {
    const TS = IsoTimestamp.trustString('2026-04-29T12:00:00.000Z');
    const p0 = Project.create({
      name: name(),
      displayName: 'Demo',
      repositories: [repo('/abs/r1')],
    });
    if (!p0.ok) throw new Error('precondition failed');
    const p1 = p0.value.updateRepository(path('/abs/r1'), { onboardedAt: TS });
    expect(p1.ok).toBe(true);
    if (!p1.ok) return;
    expect(p1.value.repositories[0]?.onboardedAt).toBe(TS);
  });

  it('clears onboardedAt when null is passed via updateRepository', () => {
    const TS = IsoTimestamp.trustString('2026-04-29T12:00:00.000Z');
    const seeded = Repository.create({ path: path('/abs/r1'), onboardedAt: TS });
    if (!seeded.ok) throw new Error('precondition failed');
    const p0 = Project.create({
      name: name(),
      displayName: 'Demo',
      repositories: [seeded.value],
    });
    if (!p0.ok) throw new Error('precondition failed');
    const p1 = p0.value.updateRepository(path('/abs/r1'), { onboardedAt: null });
    expect(p1.ok).toBe(true);
    if (!p1.ok) return;
    expect(p1.value.repositories[0]?.onboardedAt).toBeNull();
  });
});
