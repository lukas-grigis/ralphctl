import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestEnv, type TestEnvironment } from '@src/test-utils/setup.ts';
import {
  addProjectRepo,
  createProject,
  getProject,
  listProjects,
  removeProject,
  removeProjectRepo,
} from './project.ts';
import { ProjectExistsError, ProjectNotFoundError, ValidationError } from '@src/domain/errors.ts';

let env: TestEnvironment;

beforeEach(async () => {
  env = await createTestEnv();
  process.env['RALPHCTL_ROOT'] = env.testDir;
});

afterEach(async () => {
  await env.cleanup();
  delete process.env['RALPHCTL_ROOT'];
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProject(name: string, repoPath: string) {
  return {
    name,
    displayName: `Display ${name}`,
    repositories: [{ name, path: repoPath }],
  };
}

// ---------------------------------------------------------------------------
// listProjects
// ---------------------------------------------------------------------------

describe('listProjects', () => {
  it('returns empty array when projects file does not exist', async () => {
    const { rm } = await import('node:fs/promises');
    const { join } = await import('node:path');
    await rm(join(env.testDir, 'projects.json'), { force: true });

    const projects = await listProjects();
    expect(projects).toEqual([]);
  });

  it('returns existing projects from file', async () => {
    // createTestEnv writes a test-project entry
    const projects = await listProjects();
    expect(projects.length).toBeGreaterThanOrEqual(1);
    expect(projects.some((p) => p.name === 'test-project')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createProject / getProject
// ---------------------------------------------------------------------------

describe('createProject and getProject', () => {
  it('stores a project and retrieves it by name', async () => {
    await createProject(makeProject('my-app', env.projectDir));
    const retrieved = await getProject('my-app');
    expect(retrieved.name).toBe('my-app');
    expect(retrieved.displayName).toBe('Display my-app');
  });

  it('throws ProjectExistsError when creating a duplicate project name', async () => {
    await createProject(makeProject('dup-app', env.projectDir));
    await expect(createProject(makeProject('dup-app', env.projectDir))).rejects.toThrow(ProjectExistsError);
  });

  it('throws ProjectNotFoundError when getting an unknown project', async () => {
    await expect(getProject('does-not-exist')).rejects.toThrow(ProjectNotFoundError);
  });

  it('throws ValidationError when repository path does not exist', async () => {
    const badProject = makeProject('bad-paths', '/nonexistent/path/that/cannot/exist');
    await expect(createProject(badProject)).rejects.toThrow(ValidationError);
  });

  it('resolves relative repository paths to absolute', async () => {
    const project = await createProject(makeProject('abs-test', env.projectDir));
    expect(project.repositories[0]?.path).toMatch(/^\//);
  });
});

// ---------------------------------------------------------------------------
// removeProject
// ---------------------------------------------------------------------------

describe('removeProject', () => {
  it('removes an existing project so it can no longer be retrieved', async () => {
    await createProject(makeProject('removable', env.projectDir));
    await removeProject('removable');
    await expect(getProject('removable')).rejects.toThrow(ProjectNotFoundError);
  });

  it('throws ProjectNotFoundError when removing a non-existent project', async () => {
    await expect(removeProject('ghost-project')).rejects.toThrow(ProjectNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// addProjectRepo
// ---------------------------------------------------------------------------

describe('addProjectRepo', () => {
  it('adds a new repository to an existing project', async () => {
    // Create a second real directory for the extra repo
    const { mkdtemp } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const extraDir = await mkdtemp(join(tmpdir(), 'ralphctl-extra-'));

    try {
      await createProject(makeProject('multi-repo', env.projectDir));
      const updated = await addProjectRepo('multi-repo', { name: 'extra', path: extraDir });
      expect(updated.repositories).toHaveLength(2);
      expect(updated.repositories.some((r) => r.path === extraDir)).toBe(true);
    } finally {
      const { rm } = await import('node:fs/promises');
      await rm(extraDir, { recursive: true, force: true });
    }
  });

  it('is a no-op when the same path is added again', async () => {
    await createProject(makeProject('no-dup', env.projectDir));
    const updated = await addProjectRepo('no-dup', { name: 'same', path: env.projectDir });
    expect(updated.repositories).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// removeProjectRepo
// ---------------------------------------------------------------------------

describe('removeProjectRepo', () => {
  it('removes a repository from a project with multiple repos', async () => {
    const { mkdtemp } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const extraDir = await mkdtemp(join(tmpdir(), 'ralphctl-extra-'));

    try {
      await createProject(makeProject('two-repos', env.projectDir));
      await addProjectRepo('two-repos', { name: 'extra', path: extraDir });

      const updated = await removeProjectRepo('two-repos', extraDir);
      expect(updated.repositories).toHaveLength(1);
      expect(updated.repositories[0]?.path).toBe(env.projectDir);
    } finally {
      const { rm } = await import('node:fs/promises');
      await rm(extraDir, { recursive: true, force: true });
    }
  });

  it('throws ValidationError when trying to remove the last repository', async () => {
    await createProject(makeProject('solo-repo', env.projectDir));
    await expect(removeProjectRepo('solo-repo', env.projectDir)).rejects.toThrow(ValidationError);
  });
});
