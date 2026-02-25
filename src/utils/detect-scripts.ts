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

export interface CheckCandidate {
  label: string;
  command: string;
  selected: boolean;
}

export interface DetectionResult {
  type: ProjectType;
  typeLabel: string;
  installCommand: string | null;
  candidates: CheckCandidate[];
}

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

// ---------------------------------------------------------------------------
// Internal: Node.js package manager detection
// ---------------------------------------------------------------------------

/**
 * Detect the Node.js package manager from lockfiles.
 */
function detectNodePackageManager(projectPath: string): string {
  if (existsSync(join(projectPath, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(projectPath, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

// ---------------------------------------------------------------------------
// Ecosystem detector registry
// ---------------------------------------------------------------------------

interface EcosystemDetector {
  type: ProjectType;
  label: string;
  detect: (path: string) => boolean;
  getInstallCommand: (path: string) => string | null;
  getCandidates: (path: string) => CheckCandidate[];
}

/** Alias groups for Node.js script detection — first match wins per group. */
const NODE_PRIMARY_GROUPS: { label: string; aliases: string[] }[] = [
  { label: 'linting', aliases: ['lint', 'eslint', 'lint:check'] },
  { label: 'type checking', aliases: ['typecheck', 'type-check', 'tsc', 'check-types'] },
  { label: 'tests', aliases: ['test', 'test:unit', 'test:run', 'vitest', 'jest'] },
];

const NODE_FALLBACK_GROUPS: { label: string; aliases: string[] }[] = [
  { label: 'build', aliases: ['build', 'compile'] },
];

function readPackageJsonScripts(projectPath: string): Record<string, string> {
  try {
    const raw = readFileSync(join(projectPath, 'package.json'), 'utf-8');
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    return pkg.scripts ?? {};
  } catch {
    return {};
  }
}

const nodeDetector: EcosystemDetector = {
  type: 'node',
  label: 'Node.js',
  detect: (path) => existsSync(join(path, 'package.json')),
  getInstallCommand: (path) => {
    const pm = detectNodePackageManager(path);
    return `${pm} install`;
  },
  getCandidates: (path) => {
    const scripts = readPackageJsonScripts(path);
    const pm = detectNodePackageManager(path);
    const run = pm === 'npm' ? 'npm run' : pm;
    const candidates: CheckCandidate[] = [];

    for (const group of NODE_PRIMARY_GROUPS) {
      const match = group.aliases.find((name) => name in scripts);
      if (match) {
        candidates.push({ label: group.label, command: `${run} ${match}`, selected: true });
      }
    }

    if (candidates.length === 0) {
      for (const group of NODE_FALLBACK_GROUPS) {
        const match = group.aliases.find((name) => name in scripts);
        if (match) {
          candidates.push({ label: group.label, command: `${run} ${match}`, selected: false });
        }
      }
    }

    return candidates;
  },
};

const pythonDetector: EcosystemDetector = {
  type: 'python',
  label: 'Python',
  detect: (path) => existsSync(join(path, 'pyproject.toml')) || existsSync(join(path, 'setup.py')),
  getInstallCommand: (path) => {
    if (existsSync(join(path, 'uv.lock'))) return 'uv sync';
    if (existsSync(join(path, 'requirements.txt'))) return 'pip install -r requirements.txt';
    if (existsSync(join(path, 'pyproject.toml'))) return 'pip install -e .';
    return null;
  },
  getCandidates: () => [{ label: 'tests', command: 'pytest', selected: true }],
};

const goDetector: EcosystemDetector = {
  type: 'go',
  label: 'Go',
  detect: (path) => existsSync(join(path, 'go.mod')),
  getInstallCommand: () => 'go mod download',
  getCandidates: () => [
    { label: 'tests', command: 'go test ./...', selected: true },
    { label: 'vet', command: 'go vet ./...', selected: true },
  ],
};

const rustDetector: EcosystemDetector = {
  type: 'rust',
  label: 'Rust',
  detect: (path) => existsSync(join(path, 'Cargo.toml')),
  getInstallCommand: () => 'cargo build',
  getCandidates: () => [
    { label: 'tests', command: 'cargo test', selected: true },
    { label: 'clippy', command: 'cargo clippy', selected: false },
  ],
};

const gradleDetector: EcosystemDetector = {
  type: 'java-gradle' as ProjectType,
  label: 'Java (Gradle)',
  detect: (path) => existsSync(join(path, 'build.gradle')) || existsSync(join(path, 'build.gradle.kts')),
  getInstallCommand: () => null,
  getCandidates: () => [{ label: 'clean build', command: './gradlew clean build', selected: true }],
};

const mavenDetector: EcosystemDetector = {
  type: 'java-maven' as ProjectType,
  label: 'Java (Maven)',
  detect: (path) => existsSync(join(path, 'pom.xml')),
  getInstallCommand: () => null,
  getCandidates: () => [{ label: 'clean install', command: 'mvn clean install', selected: true }],
};

const makefileDetector: EcosystemDetector = {
  type: 'makefile' as ProjectType,
  label: 'Makefile',
  detect: (path) => existsSync(join(path, 'Makefile')),
  getInstallCommand: () => null,
  getCandidates: () => [{ label: 'check/test', command: 'make check || make test', selected: true }],
};

/** Ordered by priority — first match wins. */
const ECOSYSTEM_REGISTRY: EcosystemDetector[] = [
  nodeDetector,
  pythonDetector,
  goDetector,
  rustDetector,
  gradleDetector,
  mavenDetector,
  makefileDetector,
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect ecosystem and return structured check-script candidates.
 * Returns null if the project type is unrecognized ('other').
 */
export function detectCheckScriptCandidates(projectPath: string): DetectionResult | null {
  for (const detector of ECOSYSTEM_REGISTRY) {
    if (detector.detect(projectPath)) {
      return {
        type: detector.type,
        typeLabel: detector.label,
        installCommand: detector.getInstallCommand(projectPath),
        candidates: detector.getCandidates(projectPath),
      };
    }
  }
  return null;
}

/**
 * Convenience wrapper: detect ecosystem and combine install command with
 * pre-selected candidates into a single shell command string.
 * Returns null if no ecosystem is detected.
 */
export function suggestCheckScript(projectPath: string): string | null {
  const result = detectCheckScriptCandidates(projectPath);
  if (!result) return null;

  const parts: string[] = [];
  if (result.installCommand) parts.push(result.installCommand);

  const selected = result.candidates.filter((c) => c.selected).map((c) => c.command);
  parts.push(...selected);

  return parts.length > 0 ? parts.join(' && ') : null;
}
