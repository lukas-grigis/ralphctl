import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { detectCheckScriptCandidates, detectProjectType, suggestCheckScript } from './detect-scripts.ts';

describe('detectProjectType', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ralphctl-detect-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('detects Node.js projects', () => {
    writeFileSync(join(tempDir, 'package.json'), '{}');
    expect(detectProjectType(tempDir)).toBe('node');
  });

  it('detects Python projects from pyproject.toml', () => {
    writeFileSync(join(tempDir, 'pyproject.toml'), '[project]');
    expect(detectProjectType(tempDir)).toBe('python');
  });

  it('detects Python projects from setup.py', () => {
    writeFileSync(join(tempDir, 'setup.py'), 'from setuptools import setup');
    expect(detectProjectType(tempDir)).toBe('python');
  });

  it('detects Go projects', () => {
    writeFileSync(join(tempDir, 'go.mod'), 'module example.com/test');
    expect(detectProjectType(tempDir)).toBe('go');
  });

  it('detects Rust projects', () => {
    writeFileSync(join(tempDir, 'Cargo.toml'), '[package]');
    expect(detectProjectType(tempDir)).toBe('rust');
  });

  it('detects Gradle projects', () => {
    writeFileSync(join(tempDir, 'build.gradle'), 'plugins {}');
    expect(detectProjectType(tempDir)).toBe('java-gradle');
  });

  it('detects Gradle Kotlin DSL projects', () => {
    writeFileSync(join(tempDir, 'build.gradle.kts'), 'plugins {}');
    expect(detectProjectType(tempDir)).toBe('java-gradle');
  });

  it('detects Maven projects', () => {
    writeFileSync(join(tempDir, 'pom.xml'), '<project></project>');
    expect(detectProjectType(tempDir)).toBe('java-maven');
  });

  it('detects Makefile projects', () => {
    writeFileSync(join(tempDir, 'Makefile'), 'all:\n\techo hello');
    expect(detectProjectType(tempDir)).toBe('makefile');
  });

  it('returns other for unknown project type', () => {
    expect(detectProjectType(tempDir)).toBe('other');
  });
});

describe('detectCheckScriptCandidates', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ralphctl-detect-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns null for unknown project type', () => {
    expect(detectCheckScriptCandidates(tempDir)).toBeNull();
  });

  describe('Node.js detection', () => {
    it('returns structured result with install and candidates', () => {
      writeFileSync(
        join(tempDir, 'package.json'),
        JSON.stringify({ scripts: { lint: 'eslint .', typecheck: 'tsc --noEmit', test: 'vitest' } })
      );
      const result = detectCheckScriptCandidates(tempDir);
      expect(result).toMatchObject({
        type: 'node',
        typeLabel: 'Node.js',
        installCommand: 'npm install',
        candidates: [
          { label: 'linting', command: 'npm run lint', selected: true },
          { label: 'type checking', command: 'npm run typecheck', selected: true },
          { label: 'tests', command: 'npm run test', selected: true },
        ],
      });
    });

    it('detects pnpm package manager', () => {
      writeFileSync(join(tempDir, 'package.json'), JSON.stringify({ scripts: { lint: 'eslint .', test: 'vitest' } }));
      writeFileSync(join(tempDir, 'pnpm-lock.yaml'), '');
      const result = detectCheckScriptCandidates(tempDir);
      expect(result).toMatchObject({
        installCommand: 'pnpm install',
        candidates: [
          { label: 'linting', command: 'pnpm lint', selected: true },
          { label: 'tests', command: 'pnpm test', selected: true },
        ],
      });
    });

    it('detects yarn package manager', () => {
      writeFileSync(join(tempDir, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }));
      writeFileSync(join(tempDir, 'yarn.lock'), '');
      const result = detectCheckScriptCandidates(tempDir);
      expect(result).toMatchObject({
        installCommand: 'yarn install',
        candidates: [{ label: 'tests', command: 'yarn test', selected: true }],
      });
    });

    it('matches lint:check alias', () => {
      writeFileSync(
        join(tempDir, 'package.json'),
        JSON.stringify({ scripts: { 'lint:check': 'eslint .', test: 'vitest' } })
      );
      const result = detectCheckScriptCandidates(tempDir);
      expect(result?.candidates.map((c) => c.command)).toContain('npm run lint:check');
    });

    it('matches type-check alias', () => {
      writeFileSync(join(tempDir, 'package.json'), JSON.stringify({ scripts: { 'type-check': 'tsc --noEmit' } }));
      const result = detectCheckScriptCandidates(tempDir);
      expect(result?.candidates).toEqual([{ label: 'type checking', command: 'npm run type-check', selected: true }]);
    });

    it('matches tsc alias for typecheck', () => {
      writeFileSync(join(tempDir, 'package.json'), JSON.stringify({ scripts: { tsc: 'tsc --noEmit' } }));
      const result = detectCheckScriptCandidates(tempDir);
      expect(result?.candidates).toEqual([{ label: 'type checking', command: 'npm run tsc', selected: true }]);
    });

    it('matches check-types alias for typecheck', () => {
      writeFileSync(
        join(tempDir, 'package.json'),
        JSON.stringify({ scripts: { 'check-types': 'tsc --noEmit', 'test:unit': 'vitest' } })
      );
      const result = detectCheckScriptCandidates(tempDir);
      expect(result?.candidates).toEqual([
        { label: 'type checking', command: 'npm run check-types', selected: true },
        { label: 'tests', command: 'npm run test:unit', selected: true },
      ]);
    });

    it('matches test:unit alias', () => {
      writeFileSync(join(tempDir, 'package.json'), JSON.stringify({ scripts: { 'test:unit': 'vitest' } }));
      const result = detectCheckScriptCandidates(tempDir);
      expect(result?.candidates).toEqual([{ label: 'tests', command: 'npm run test:unit', selected: true }]);
    });

    it('matches test:run alias', () => {
      writeFileSync(join(tempDir, 'package.json'), JSON.stringify({ scripts: { 'test:run': 'vitest run' } }));
      const result = detectCheckScriptCandidates(tempDir);
      expect(result?.candidates).toEqual([{ label: 'tests', command: 'npm run test:run', selected: true }]);
    });

    it('matches vitest alias', () => {
      writeFileSync(join(tempDir, 'package.json'), JSON.stringify({ scripts: { vitest: 'vitest run' } }));
      const result = detectCheckScriptCandidates(tempDir);
      expect(result?.candidates).toEqual([{ label: 'tests', command: 'npm run vitest', selected: true }]);
    });

    it('matches jest alias', () => {
      writeFileSync(join(tempDir, 'package.json'), JSON.stringify({ scripts: { jest: 'jest --coverage' } }));
      const result = detectCheckScriptCandidates(tempDir);
      expect(result?.candidates).toEqual([{ label: 'tests', command: 'npm run jest', selected: true }]);
    });

    it('matches eslint alias for lint', () => {
      writeFileSync(join(tempDir, 'package.json'), JSON.stringify({ scripts: { eslint: 'eslint .' } }));
      const result = detectCheckScriptCandidates(tempDir);
      expect(result?.candidates).toEqual([{ label: 'linting', command: 'npm run eslint', selected: true }]);
    });

    it('prefers first alias in each category', () => {
      writeFileSync(
        join(tempDir, 'package.json'),
        JSON.stringify({ scripts: { lint: 'eslint .', 'lint:check': 'eslint . --max-warnings=0' } })
      );
      const result = detectCheckScriptCandidates(tempDir);
      expect(result?.candidates).toEqual([{ label: 'linting', command: 'npm run lint', selected: true }]);
    });

    it('falls back to build script when no primary scripts match', () => {
      writeFileSync(
        join(tempDir, 'package.json'),
        JSON.stringify({ scripts: { start: 'node index.js', build: 'tsc' } })
      );
      const result = detectCheckScriptCandidates(tempDir);
      expect(result?.candidates).toEqual([{ label: 'build', command: 'npm run build', selected: false }]);
    });

    it('falls back to compile script when no primary scripts match', () => {
      writeFileSync(
        join(tempDir, 'package.json'),
        JSON.stringify({ scripts: { start: 'node index.js', compile: 'tsc' } })
      );
      const result = detectCheckScriptCandidates(tempDir);
      expect(result?.candidates).toEqual([{ label: 'build', command: 'npm run compile', selected: false }]);
    });

    it('returns empty candidates when no scripts match at all', () => {
      writeFileSync(join(tempDir, 'package.json'), JSON.stringify({ scripts: { start: 'node index.js' } }));
      const result = detectCheckScriptCandidates(tempDir);
      expect(result?.candidates).toEqual([]);
    });

    it('returns empty candidates for empty scripts object', () => {
      writeFileSync(join(tempDir, 'package.json'), JSON.stringify({ scripts: {} }));
      const result = detectCheckScriptCandidates(tempDir);
      expect(result?.candidates).toEqual([]);
    });

    it('returns empty candidates when no scripts field at all', () => {
      writeFileSync(join(tempDir, 'package.json'), JSON.stringify({ name: 'my-app' }));
      const result = detectCheckScriptCandidates(tempDir);
      expect(result?.candidates).toEqual([]);
    });
  });

  describe('Python detection', () => {
    it('returns pytest candidate', () => {
      writeFileSync(join(tempDir, 'pyproject.toml'), '[tool.pytest]');
      const result = detectCheckScriptCandidates(tempDir);
      expect(result).toMatchObject({
        type: 'python',
        candidates: [{ label: 'tests', command: 'pytest', selected: true }],
      });
    });

    it('detects uv sync install command', () => {
      writeFileSync(join(tempDir, 'pyproject.toml'), '[project]');
      writeFileSync(join(tempDir, 'uv.lock'), '');
      const result = detectCheckScriptCandidates(tempDir);
      expect(result?.installCommand).toBe('uv sync');
    });

    it('detects pip install -r for requirements.txt', () => {
      writeFileSync(join(tempDir, 'pyproject.toml'), '[project]');
      writeFileSync(join(tempDir, 'requirements.txt'), 'flask');
      const result = detectCheckScriptCandidates(tempDir);
      expect(result?.installCommand).toBe('pip install -r requirements.txt');
    });

    it('detects pip install -e . for pyproject.toml only', () => {
      writeFileSync(join(tempDir, 'pyproject.toml'), '[project]');
      const result = detectCheckScriptCandidates(tempDir);
      expect(result?.installCommand).toBe('pip install -e .');
    });

    it('returns null install command for setup.py only', () => {
      writeFileSync(join(tempDir, 'setup.py'), 'from setuptools import setup');
      const result = detectCheckScriptCandidates(tempDir);
      expect(result?.installCommand).toBeNull();
    });
  });

  describe('Go detection', () => {
    it('returns test and vet candidates', () => {
      writeFileSync(join(tempDir, 'go.mod'), 'module example.com/test');
      const result = detectCheckScriptCandidates(tempDir);
      expect(result).toMatchObject({
        type: 'go',
        installCommand: 'go mod download',
        candidates: [
          { label: 'tests', command: 'go test ./...', selected: true },
          { label: 'vet', command: 'go vet ./...', selected: true },
        ],
      });
    });
  });

  describe('Rust detection', () => {
    it('returns test and clippy candidates', () => {
      writeFileSync(join(tempDir, 'Cargo.toml'), '[package]');
      const result = detectCheckScriptCandidates(tempDir);
      expect(result).toMatchObject({
        type: 'rust',
        installCommand: 'cargo build',
        candidates: [
          { label: 'tests', command: 'cargo test', selected: true },
          { label: 'clippy', command: 'cargo clippy', selected: false },
        ],
      });
    });
  });

  describe('Gradle detection', () => {
    it('returns clean build candidate', () => {
      writeFileSync(join(tempDir, 'build.gradle'), 'plugins {}');
      const result = detectCheckScriptCandidates(tempDir);
      expect(result).toMatchObject({
        type: 'java-gradle',
        installCommand: null,
        candidates: [{ label: 'clean build', command: './gradlew clean build', selected: true }],
      });
    });
  });

  describe('Maven detection', () => {
    it('returns clean install candidate', () => {
      writeFileSync(join(tempDir, 'pom.xml'), '<project></project>');
      const result = detectCheckScriptCandidates(tempDir);
      expect(result).toMatchObject({
        type: 'java-maven',
        installCommand: null,
        candidates: [{ label: 'clean install', command: 'mvn clean install', selected: true }],
      });
    });
  });

  describe('Makefile detection', () => {
    it('returns check/test candidate', () => {
      writeFileSync(join(tempDir, 'Makefile'), 'check:\n\techo "checking"');
      const result = detectCheckScriptCandidates(tempDir);
      expect(result).toMatchObject({
        type: 'makefile',
        installCommand: null,
        candidates: [{ label: 'check/test', command: 'make check || make test', selected: true }],
      });
    });
  });
});

describe('suggestCheckScript', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ralphctl-detect-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('combines install and selected candidates for Node.js with pnpm', () => {
    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({ scripts: { typecheck: 'tsc', lint: 'eslint .', test: 'vitest' } })
    );
    writeFileSync(join(tempDir, 'pnpm-lock.yaml'), '');
    expect(suggestCheckScript(tempDir)).toBe('pnpm install && pnpm lint && pnpm typecheck && pnpm test');
  });

  it('combines install and selected candidates for Go', () => {
    writeFileSync(join(tempDir, 'go.mod'), 'module example.com/test');
    expect(suggestCheckScript(tempDir)).toBe('go mod download && go test ./... && go vet ./...');
  });

  it('combines install and selected candidates for Rust', () => {
    writeFileSync(join(tempDir, 'Cargo.toml'), '[package]');
    expect(suggestCheckScript(tempDir)).toBe('cargo build && cargo test');
  });

  it('returns only candidates for Gradle', () => {
    writeFileSync(join(tempDir, 'build.gradle'), 'plugins {}');
    expect(suggestCheckScript(tempDir)).toBe('./gradlew clean build');
  });

  it('returns only candidates for Maven', () => {
    writeFileSync(join(tempDir, 'pom.xml'), '<project></project>');
    expect(suggestCheckScript(tempDir)).toBe('mvn clean install');
  });

  it('combines install and candidates for Python with pyproject.toml', () => {
    writeFileSync(join(tempDir, 'pyproject.toml'), '[project]');
    expect(suggestCheckScript(tempDir)).toBe('pip install -e . && pytest');
  });

  it('returns only candidates for Makefile', () => {
    writeFileSync(join(tempDir, 'Makefile'), 'check:\n\techo "checking"');
    expect(suggestCheckScript(tempDir)).toBe('make check || make test');
  });

  it('returns null for unknown project type', () => {
    expect(suggestCheckScript(tempDir)).toBeNull();
  });

  it('excludes non-selected candidates', () => {
    writeFileSync(join(tempDir, 'Cargo.toml'), '[package]');
    // Rust: cargo test is selected, cargo clippy is NOT
    expect(suggestCheckScript(tempDir)).toBe('cargo build && cargo test');
  });

  it('returns only install command when no candidates are selected', () => {
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({ scripts: { start: 'node index.js', build: 'tsc' } }));
    // Build is a fallback candidate and NOT selected
    expect(suggestCheckScript(tempDir)).toBe('npm install');
  });

  it('returns only install command for Node.js with no matching scripts', () => {
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({ scripts: {} }));
    expect(suggestCheckScript(tempDir)).toBe('npm install');
  });
});
