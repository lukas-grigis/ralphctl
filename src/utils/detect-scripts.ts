import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Canonical project-type detection and script suggestion.
 *
 * Used during `project add` and `project repo add` to pre-fill setup/verify
 * scripts as editable suggestions. NOT used at runtime — scripts must come
 * from explicit repo config only.
 */

export type ProjectType = 'node' | 'python' | 'go' | 'rust' | 'java-gradle' | 'java-maven' | 'makefile' | 'other';

/**
 * Detect project type from files in the path.
 */
export function detectProjectType(projectPath: string): ProjectType {
  if (existsSync(join(projectPath, 'package.json'))) return 'node';
  if (existsSync(join(projectPath, 'pyproject.toml')) || existsSync(join(projectPath, 'setup.py'))) return 'python';
  if (existsSync(join(projectPath, 'go.mod'))) return 'go';
  if (existsSync(join(projectPath, 'Cargo.toml'))) return 'rust';
  if (existsSync(join(projectPath, 'build.gradle')) || existsSync(join(projectPath, 'build.gradle.kts')))
    return 'java-gradle';
  if (existsSync(join(projectPath, 'pom.xml'))) return 'java-maven';
  if (existsSync(join(projectPath, 'Makefile'))) return 'makefile';
  return 'other';
}

/**
 * Get human-readable label for project type.
 */
export function getProjectTypeLabel(type: ProjectType): string {
  const labels: Record<ProjectType, string> = {
    node: 'Node.js',
    python: 'Python',
    go: 'Go',
    rust: 'Rust',
    'java-gradle': 'Java (Gradle)',
    'java-maven': 'Java (Maven)',
    makefile: 'Makefile',
    other: 'Unknown',
  };
  return labels[type];
}

/**
 * Detect the Node.js package manager from lockfiles.
 */
function detectNodePackageManager(projectPath: string): string {
  if (existsSync(join(projectPath, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(projectPath, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

/**
 * Suggest a setup script based on project type.
 * Calls detectProjectType internally if type is not provided.
 */
export function suggestSetupScript(projectPath: string, type?: ProjectType): string | null {
  const t = type ?? detectProjectType(projectPath);

  switch (t) {
    case 'node': {
      const pm = detectNodePackageManager(projectPath);
      return `${pm} install`;
    }
    case 'python': {
      if (existsSync(join(projectPath, 'uv.lock'))) return 'uv sync';
      if (existsSync(join(projectPath, 'requirements.txt'))) return 'pip install -r requirements.txt';
      if (existsSync(join(projectPath, 'pyproject.toml'))) return 'pip install -e .';
      return null;
    }
    case 'go':
      return 'go mod download';
    case 'rust':
      return 'cargo build';
    case 'java-gradle':
      return './gradlew clean build';
    case 'java-maven':
      return 'mvn clean install';
    default:
      return null;
  }
}

/** Alias groups for Node.js verify script detection (first match wins per group). */
const NODE_SCRIPT_ALIASES: { category: string; names: string[] }[] = [
  { category: 'lint', names: ['lint', 'eslint', 'lint:check'] },
  { category: 'typecheck', names: ['typecheck', 'type-check', 'tsc', 'check-types'] },
  { category: 'test', names: ['test', 'test:unit', 'test:run', 'vitest', 'jest'] },
];

const NODE_SCRIPT_FALLBACK_ALIASES: { category: string; names: string[] }[] = [
  { category: 'build', names: ['build', 'compile'] },
];

/**
 * Find the first matching script name from a group of aliases.
 */
function findNodeScript(scripts: Record<string, string>, aliases: string[]): string | undefined {
  return aliases.find((name) => name in scripts);
}

/**
 * Suggest a verify script based on project type.
 * Calls detectProjectType internally if type is not provided.
 */
export function suggestVerifyScript(projectPath: string, type?: ProjectType): string | null {
  const t = type ?? detectProjectType(projectPath);

  switch (t) {
    case 'node': {
      try {
        const pkgPath = join(projectPath, 'package.json');
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
          scripts?: Record<string, string>;
        };
        const scripts = pkg.scripts ?? {};
        const commands: string[] = [];

        const pkgManager = detectNodePackageManager(projectPath);
        const run = pkgManager === 'npm' ? 'npm run' : pkgManager;

        // Match primary aliases (lint, typecheck, test)
        for (const group of NODE_SCRIPT_ALIASES) {
          const match = findNodeScript(scripts, group.names);
          if (match) commands.push(`${run} ${match}`);
        }

        // If no primary matches, try fallback aliases (build, compile)
        if (commands.length === 0) {
          for (const group of NODE_SCRIPT_FALLBACK_ALIASES) {
            const match = findNodeScript(scripts, group.names);
            if (match) commands.push(`${run} ${match}`);
          }
        }

        if (commands.length > 0) {
          return commands.join(' && ');
        }

        // Last resort: suggest package manager test command
        return `${pkgManager} test`;
      } catch {
        // Fallback if can't read package.json
      }
      return null;
    }
    case 'python':
      return 'pytest';
    case 'go':
      return 'go test ./...';
    case 'rust':
      return 'cargo test';
    case 'java-gradle':
      return './gradlew check';
    case 'java-maven':
      return 'mvn clean install';
    case 'makefile':
      return 'make check || make test';
    default:
      return null;
  }
}
