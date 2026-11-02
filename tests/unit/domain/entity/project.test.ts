import { describe, expect, it } from 'vitest';
import {
  addRepository,
  createProject,
  removeRepository,
  setProjectDisplayName,
  setProjectSlug,
  updateRepository,
} from '@src/domain/entity/project.ts';
import { absolutePath, FIXED_REPOSITORY_ID, makeProject, makeRepository, slug } from '@tests/fixtures/domain.ts';
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
    const rValue = r.getOrThrow();
    expect(rValue.slug).toBe('my-demo-project');
  });
});

describe('addRepository', () => {
  it('adds a new repository', () => {
    const r = addRepository(
      makeProject(),
      makeRepository({ id: RepositoryId.generate(), slug: 'aux', name: 'aux', path: '/tmp/aux' })
    );
    const rValue = r.getOrThrow();
    expect(rValue.repositories).toHaveLength(2);
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
    const rValue = r.getOrThrow();
    expect(rValue.repositories).toHaveLength(1);
  });

  it("returns ValidationError when id doesn't exist", () => {
    const r = removeRepository(makeProject(), RepositoryId.generate());
    expect(r.ok).toBe(false);
  });
});

describe('setProjectDisplayName', () => {
  it('renames the project', () => {
    const r = setProjectDisplayName(makeProject(), 'New Label');
    const value = r.getOrThrow();
    expect(value.displayName).toBe('New Label');
  });

  it('rejects whitespace-only input', () => {
    const r = setProjectDisplayName(makeProject(), '   ');
    expect(r.ok).toBe(false);
  });
});

describe('setProjectSlug', () => {
  it('replaces the slug verbatim', () => {
    const r = setProjectSlug(makeProject(), slug('new-handle'));
    expect(r.slug).toBe('new-handle');
    void r;
  });
});

describe('updateRepository', () => {
  it('updates the named field on the matching repository', () => {
    const proj = makeProject();
    const r = updateRepository(proj, FIXED_REPOSITORY_ID, { name: 'renamed' });
    const rValue = r.getOrThrow();
    expect(rValue.repositories[0]?.name).toBe('renamed');
  });

  it('updates path through the AbsolutePath brand', () => {
    const newRepo = createRepository({
      id: FIXED_REPOSITORY_ID,
      path: absolutePath('/elsewhere/main-repo'),
    });
    if (!newRepo.ok) throw new Error('seed');
    const r = updateRepository(makeProject(), FIXED_REPOSITORY_ID, { path: newRepo.value.path });
    const rValue = r.getOrThrow();
    expect(rValue.repositories[0]?.path).toBe('/elsewhere/main-repo');
  });

  it('trims and de-duplicates suggestedSkills on update', () => {
    const r = updateRepository(makeProject(), FIXED_REPOSITORY_ID, {
      suggestedSkills: ['  react-patterns  ', 'pnpm', 'react-patterns', '   '],
    });
    const rValue = r.getOrThrow();
    // Trimmed, blank-dropped, first-wins de-dupe.
    expect(rValue.repositories[0]?.suggestedSkills).toEqual(['react-patterns', 'pnpm']);
  });

  it('clears suggestedSkills when patched with an empty / all-blank list', () => {
    const seeded = createRepository({
      id: FIXED_REPOSITORY_ID,
      path: absolutePath('/tmp/with-suggestions'),
      suggestedSkills: ['react-patterns'],
    });
    if (!seeded.ok) throw new Error('seed');
    const proj = makeProject({ repositories: [seeded.value] });
    expect(proj.repositories[0]?.suggestedSkills).toEqual(['react-patterns']);

    const r = updateRepository(proj, FIXED_REPOSITORY_ID, { suggestedSkills: ['   '] });
    const rValue = r.getOrThrow();
    // All-blank list collapses to "no suggestions" → field removed entirely.
    expect(rValue.repositories[0]?.suggestedSkills).toBeUndefined();
    expect('suggestedSkills' in (rValue.repositories[0] ?? {})).toBe(false);
  });

  it('persists structured verifyGates alongside the verify script (additive)', () => {
    const seeded = createRepository({
      id: FIXED_REPOSITORY_ID,
      path: absolutePath('/tmp/monorepo'),
      verifyScript: 'root-verify',
    });
    if (!seeded.ok) throw new Error('seed');
    const proj = makeProject({ repositories: [seeded.value] });

    const r = updateRepository(proj, FIXED_REPOSITORY_ID, {
      verifyGates: [
        { pathPrefix: 'services/api/', command: 'api-verify' },
        { pathPrefix: 'services/web/', command: 'web-verify', timeoutMs: 90_000 },
      ],
    });
    const value = r.getOrThrow();
    const saved = value.repositories[0];
    // Gates land, AND the legacy verify script is preserved — they coexist.
    expect(saved?.verifyScript).toBe('root-verify');
    expect(saved?.verifyGates).toEqual([
      { pathPrefix: 'services/api/', command: 'api-verify' },
      { pathPrefix: 'services/web/', command: 'web-verify', timeoutMs: 90_000 },
    ]);
  });

  it('normalises gates through the entity setter — blank commands drop, all-blank clears', () => {
    const seeded = createRepository({
      id: FIXED_REPOSITORY_ID,
      path: absolutePath('/tmp/monorepo-clear'),
      verifyGates: [{ pathPrefix: 'a/', command: 'keep' }],
    });
    if (!seeded.ok) throw new Error('seed');
    const proj = makeProject({ repositories: [seeded.value] });
    expect(proj.repositories[0]?.verifyGates).toEqual([{ pathPrefix: 'a/', command: 'keep' }]);

    const r = updateRepository(proj, FIXED_REPOSITORY_ID, {
      verifyGates: [{ pathPrefix: 'a/', command: '   ' }],
    });
    const rValue = r.getOrThrow();
    // Only gate had a blank command → nothing survives → field removed entirely.
    expect(rValue.repositories[0]?.verifyGates).toBeUndefined();
    expect('verifyGates' in (rValue.repositories[0] ?? {})).toBe(false);
  });

  it('rejects a gate with a non-positive timeoutMs', () => {
    const r = updateRepository(makeProject(), FIXED_REPOSITORY_ID, {
      verifyGates: [{ pathPrefix: 'a/', command: 'check', timeoutMs: 0 }],
    });
    expect(r.ok).toBe(false);
  });
});
