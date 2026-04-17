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
  /** Stable id of the seeded project (so tests can pass `projectId`). */
  projectId: string;
  /** Stable id of the seeded project's only repo (so tests can pass `repoId`). */
  repoId: string;
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

  // Stable ids for tests — snapshot-friendly.
  const projectId = 'prj00001';
  const repoId = 'repo0001';

  await mkdir(join(testDir, 'sprints'), { recursive: true });
  await writeFile(join(testDir, 'config.json'), JSON.stringify({ currentSprint: null }));

  await writeFile(
    join(testDir, 'projects.json'),
    JSON.stringify([
      {
        id: projectId,
        name: projectName,
        displayName: 'Test Project',
        repositories: [{ id: repoId, name: projectName, path: projectDir }],
      },
    ])
  );

  return {
    testDir,
    projectDir,
    projectId,
    repoId,
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
 * Capture console.log output during an async callback.
 * Returns the joined output as a single string.
 */
export async function captureOutput(fn: () => Promise<void>): Promise<string> {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };
  try {
    await fn();
  } finally {
    console.log = originalLog;
  }
  return logs.join('\n');
}

/**
 * Create multiple project directories for multi-repo tests.
 */
export async function createMultiProjectEnv(
  projects: {
    name: string;
    displayName: string;
    description?: string;
    checkScript?: string;
  }[]
): Promise<{
  testDir: string;
  projectDirs: Map<string, string>;
  /** Map of project name → stable repo id seeded into projects.json. */
  repoIds: Map<string, string>;
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
  let idx = 0;
  for (const project of projects) {
    const dir = await mkdtemp(join(tmpdir(), `ralphctl-${project.name}-`));
    projectDirs.set(project.name, dir);
    dirs.push(dir);
    idx += 1;
    projectConfigs.push({
      id: `prj0000${String(idx)}`,
      name: project.name,
      displayName: project.displayName,
      description: project.description,
      repositories: [
        {
          id: `repo000${String(idx)}`,
          name: project.name,
          path: dir,
          checkScript: project.checkScript,
        },
      ],
    });
  }

  await writeFile(join(testDir, 'projects.json'), JSON.stringify(projectConfigs));

  // Map repoIds mirroring the deterministic generation above.
  const repoIds = new Map<string, string>();
  projects.forEach((p, i) => {
    repoIds.set(p.name, `repo000${String(i + 1)}`);
  });

  return {
    testDir,
    projectDirs,
    repoIds,
    env: { RALPHCTL_ROOT: testDir },
    cleanup: async () => {
      // Use allSettled so one failure doesn't prevent other cleanups
      await Promise.allSettled(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
    },
  };
}
