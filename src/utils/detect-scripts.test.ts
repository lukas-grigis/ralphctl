import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { detectProjectType, suggestSetupScript, suggestVerifyScript } from './detect-scripts.ts';

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

describe('suggestSetupScript', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ralphctl-detect-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('suggests pnpm install for pnpm projects', () => {
    writeFileSync(join(tempDir, 'package.json'), '{}');
    writeFileSync(join(tempDir, 'pnpm-lock.yaml'), '');
    expect(suggestSetupScript(tempDir)).toBe('pnpm install');
  });

  it('suggests yarn install for yarn projects', () => {
    writeFileSync(join(tempDir, 'package.json'), '{}');
    writeFileSync(join(tempDir, 'yarn.lock'), '');
    expect(suggestSetupScript(tempDir)).toBe('yarn install');
  });

  it('suggests npm install for npm projects', () => {
    writeFileSync(join(tempDir, 'package.json'), '{}');
    expect(suggestSetupScript(tempDir)).toBe('npm install');
  });

  it('suggests uv sync for Python projects with uv.lock', () => {
    writeFileSync(join(tempDir, 'pyproject.toml'), '[project]');
    writeFileSync(join(tempDir, 'uv.lock'), '');
    expect(suggestSetupScript(tempDir)).toBe('uv sync');
  });

  it('suggests pip install -r for Python projects with requirements.txt', () => {
    writeFileSync(join(tempDir, 'pyproject.toml'), '[project]');
    writeFileSync(join(tempDir, 'requirements.txt'), 'flask');
    expect(suggestSetupScript(tempDir)).toBe('pip install -r requirements.txt');
  });

  it('suggests pip install -e . for Python projects with only pyproject.toml', () => {
    writeFileSync(join(tempDir, 'pyproject.toml'), '[project]');
    expect(suggestSetupScript(tempDir)).toBe('pip install -e .');
  });

  it('suggests go mod download for Go projects', () => {
    writeFileSync(join(tempDir, 'go.mod'), 'module example.com/test');
    expect(suggestSetupScript(tempDir)).toBe('go mod download');
  });

  it('suggests cargo build for Rust projects', () => {
    writeFileSync(join(tempDir, 'Cargo.toml'), '[package]');
    expect(suggestSetupScript(tempDir)).toBe('cargo build');
  });

  it('suggests gradlew clean build for Gradle projects', () => {
    writeFileSync(join(tempDir, 'build.gradle'), 'plugins {}');
    expect(suggestSetupScript(tempDir)).toBe('./gradlew clean build');
  });

  it('suggests mvn clean install for Maven projects', () => {
    writeFileSync(join(tempDir, 'pom.xml'), '<project></project>');
    expect(suggestSetupScript(tempDir)).toBe('mvn clean install');
  });

  it('returns null for unknown project type', () => {
    expect(suggestSetupScript(tempDir)).toBeNull();
  });
});

describe('suggestVerifyScript', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ralphctl-detect-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('detects npm scripts from package.json', () => {
    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({
        scripts: { lint: 'eslint .', typecheck: 'tsc --noEmit', test: 'vitest' },
      })
    );
    expect(suggestVerifyScript(tempDir)).toBe('npm run lint && npm run typecheck && npm run test');
  });

  it('uses pnpm when pnpm-lock.yaml exists', () => {
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({ scripts: { lint: 'eslint .', test: 'vitest' } }));
    writeFileSync(join(tempDir, 'pnpm-lock.yaml'), '');
    expect(suggestVerifyScript(tempDir)).toBe('pnpm lint && pnpm test');
  });

  it('uses yarn when yarn.lock exists', () => {
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }));
    writeFileSync(join(tempDir, 'yarn.lock'), '');
    expect(suggestVerifyScript(tempDir)).toBe('yarn test');
  });

  it('returns null for package.json without relevant scripts', () => {
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({ scripts: { start: 'node index.js', build: 'tsc' } }));
    expect(suggestVerifyScript(tempDir)).toBeNull();
  });

  it('detects Python projects', () => {
    writeFileSync(join(tempDir, 'pyproject.toml'), '[tool.pytest]');
    expect(suggestVerifyScript(tempDir)).toBe('pytest');
  });

  it('detects Go projects', () => {
    writeFileSync(join(tempDir, 'go.mod'), 'module example.com/test');
    expect(suggestVerifyScript(tempDir)).toBe('go test ./...');
  });

  it('detects Rust projects', () => {
    writeFileSync(join(tempDir, 'Cargo.toml'), '[package]');
    expect(suggestVerifyScript(tempDir)).toBe('cargo test');
  });

  it('detects Gradle projects', () => {
    writeFileSync(join(tempDir, 'build.gradle'), 'plugins {}');
    expect(suggestVerifyScript(tempDir)).toBe('./gradlew check');
  });

  it('detects Maven projects', () => {
    writeFileSync(join(tempDir, 'pom.xml'), '<project></project>');
    expect(suggestVerifyScript(tempDir)).toBe('mvn clean install');
  });

  it('detects Makefile projects', () => {
    writeFileSync(join(tempDir, 'Makefile'), 'check:\n\techo "checking"');
    expect(suggestVerifyScript(tempDir)).toBe('make check || make test');
  });

  it('returns null for unknown project type', () => {
    expect(suggestVerifyScript(tempDir)).toBeNull();
  });
});
