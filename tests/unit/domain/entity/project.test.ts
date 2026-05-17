import { describe, expect, it } from 'vitest';
import { addRepository, createProject, removeRepository, updateRepository } from '@src/domain/entity/project.ts';
import { absolutePath, FIXED_REPOSITORY_ID, makeProject, makeRepository } from '@tests/fixtures/domain.ts';
import { createRepository } from '@src/domain/entity/repository.ts';
import { RepositoryId } from '@src/domain/value/id/repository-id.ts';

describe('createProject', () => {
  it('rejects empty repositories', () => {
    const r = createProject({
      displayName: 'Demo',
      repositories: [],
    });
    expect(r.ok).toBe(false);
  });

  it('rejects duplicate repository ids', () => {
    const a = makeRepository();
    const r = createProject({
      displayName: 'Demo',
      repositories: [a, a],
    });
    expect(r.ok).toBe(false);
  });

  it('derives slug from displayName when omitted', () => {
    const r = createProject({
      displayName: 'My Demo Project',
      repositories: [makeRepository()],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.slug).toBe('my-demo-project');
  });
});

describe('addRepository', () => {
  it('adds a new repository', () => {
    const r = addRepository(
      makeProject(),
      makeRepository({ id: RepositoryId.generate(), slug: 'aux', name: 'aux', path: '/tmp/aux' })
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.repositories).toHaveLength(2);
  });

  it('rejects duplicate id', () => {
    const r = addRepository(makeProject(), makeRepository());
    expect(r.ok).toBe(false);
  });
});

describe('removeRepository', () => {
  it('refuses to remove the last repository', () => {
    const r = removeRepository(makeProject(), FIXED_REPOSITORY_ID);
    expect(r.ok).toBe(false);
  });

  it('removes a non-last repository', () => {
    const aux = makeRepository({ id: RepositoryId.generate(), slug: 'aux', name: 'aux', path: '/tmp/aux' });
    const proj = makeProject({ repositories: [makeRepository(), aux] });
    const r = removeRepository(proj, aux.id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.repositories).toHaveLength(1);
  });

  it("returns ValidationError when id doesn't exist", () => {
    const r = removeRepository(makeProject(), RepositoryId.generate());
    expect(r.ok).toBe(false);
  });
});

describe('updateRepository', () => {
  it('updates the named field on the matching repository', () => {
    const proj = makeProject();
    const r = updateRepository(proj, FIXED_REPOSITORY_ID, { name: 'renamed' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.repositories[0]?.name).toBe('renamed');
  });

  it('updates path through the AbsolutePath brand', () => {
    const newRepo = createRepository({
      id: FIXED_REPOSITORY_ID,
      path: absolutePath('/elsewhere/main-repo'),
    });
    if (!newRepo.ok) throw new Error('seed');
    const r = updateRepository(makeProject(), FIXED_REPOSITORY_ID, { path: newRepo.value.path });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.repositories[0]?.path).toBe('/elsewhere/main-repo');
  });
});
