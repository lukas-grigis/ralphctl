/**
 * Shared test utilities for setting up test environments.
 * Reduces duplication and improves performance.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export interface TestEnvironment {
  testDir: string;
  projectDir: string;
  env: Record<string, string>;
  cleanup: () => Promise<void>;
}

/**
 * Create an isolated test environment with data directory structure.
 * Call cleanup() when done.
 */
export async function createTestEnv(options?: { projectName?: string }): Promise<TestEnvironment> {
  const projectName = options?.projectName ?? 'test-project';
  const testDir = await mkdtemp(join(tmpdir(), `ralphctl-test-${projectName}-`));
  const projectDir = await mkdtemp(join(tmpdir(), `ralphctl-project-${projectName}-`));
  const env = { RALPHCTL_ROOT: testDir };

  // Create data directory structure (RALPHCTL_ROOT points directly to data dir)
  await mkdir(join(testDir, 'sprints'), { recursive: true });
  await writeFile(join(testDir, 'config.json'), JSON.stringify({ currentSprint: null }));

  // Create projects.json with a test project
  await writeFile(
    join(testDir, 'projects.json'),
    JSON.stringify([
      {
        name: projectName,
        displayName: 'Test Project',
        repositories: [{ name: projectName, path: projectDir }],
      },
    ])
  );

  return {
    testDir,
    projectDir,
    env,
    cleanup: async () => {
      // Use allSettled so one failure doesn't prevent other cleanups
      await Promise.allSettled([
        rm(testDir, { recursive: true, force: true }),
        rm(projectDir, { recursive: true, force: true }),
      ]);
    },
  };
}

/**
 * Create multiple project directories for multi-repo tests.
 */
export async function createMultiProjectEnv(
  projects: {
    name: string;
    displayName: string;
    description?: string;
    verifyScript?: string;
  }[]
): Promise<{
  testDir: string;
  projectDirs: Map<string, string>;
  env: Record<string, string>;
  cleanup: () => Promise<void>;
}> {
  const testDir = await mkdtemp(join(tmpdir(), 'ralphctl-test-'));
  const projectDirs = new Map<string, string>();
  const dirs: string[] = [testDir];

  // Create data directory structure (RALPHCTL_ROOT points directly to data dir)
  await mkdir(join(testDir, 'sprints'), { recursive: true });
  await writeFile(join(testDir, 'config.json'), JSON.stringify({ currentSprint: null }));

  // Create project directories
  const projectConfigs = [];
  for (const project of projects) {
    const dir = await mkdtemp(join(tmpdir(), `ralphctl-${project.name}-`));
    projectDirs.set(project.name, dir);
    dirs.push(dir);
    projectConfigs.push({
      name: project.name,
      displayName: project.displayName,
      description: project.description,
      repositories: [
        {
          name: project.name,
          path: dir,
          verifyScript: project.verifyScript,
        },
      ],
    });
  }

  await writeFile(join(testDir, 'projects.json'), JSON.stringify(projectConfigs));

  return {
    testDir,
    projectDirs,
    env: { RALPHCTL_ROOT: testDir },
    cleanup: async () => {
      // Use allSettled so one failure doesn't prevent other cleanups
      await Promise.allSettled(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
    },
  };
}
