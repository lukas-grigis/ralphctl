import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectVerifyScript, getEffectiveVerifyScript, getRecentGitHistory } from './executor.ts';
import { parseExecutionResult } from './parser.ts';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { Project } from '@src/schemas/index.ts';

describe('parseExecutionResult', () => {
  describe('completion signals', () => {
    it('marks success when task-complete with task-verified', () => {
      const output = `
        Did some work...
        <task-verified>
        $ npm run lint
        ✓ No lint errors
        $ npm run test
        ✓ All tests passed
        </task-verified>
        <task-complete>
      `;
      const result = parseExecutionResult(output);
      expect(result.success).toBe(true);
      expect(result.verified).toBe(true);
      expect(result.verificationOutput).toContain('No lint errors');
      expect(result.verificationOutput).toContain('All tests passed');
    });

    it('fails when task-complete without task-verified', () => {
      const output = `
        Did some work...
        <task-complete>
      `;
      const result = parseExecutionResult(output);
      expect(result.success).toBe(false);
      expect(result.blockedReason).toContain('without verification');
    });

    it('parses task-blocked signal', () => {
      const output = `
        Tried to do work but...
        <task-blocked>Cannot find required dependency</task-blocked>
      `;
      const result = parseExecutionResult(output);
      expect(result.success).toBe(false);
      expect(result.blockedReason).toBe('Cannot find required dependency');
    });

    it('returns incomplete when no signal found', () => {
      const output = 'Did some work but never finished';
      const result = parseExecutionResult(output);
      expect(result.success).toBe(false);
      expect(result.blockedReason).toBe('No completion signal received');
    });

    it('extracts verification output even when blocked', () => {
      const output = `
        <task-verified>
        $ npm run lint
        ✓ Passed
        </task-verified>
        <task-blocked>Tests failed unexpectedly</task-blocked>
      `;
      const result = parseExecutionResult(output);
      expect(result.success).toBe(false);
      expect(result.verified).toBe(true);
      expect(result.verificationOutput).toContain('Passed');
      expect(result.blockedReason).toBe('Tests failed unexpectedly');
    });

    it('handles multiline verification output', () => {
      const output = `
        <task-verified>
        $ npm run lint

        > project@1.0.0 lint
        > eslint .

        ✓ 42 files passed

        $ npm run test

        PASS  src/test.ts
          ✓ test 1
          ✓ test 2

        Tests: 2 passed
        </task-verified>
        <task-complete>
      `;
      const result = parseExecutionResult(output);
      expect(result.success).toBe(true);
      expect(result.verified).toBe(true);
      expect(result.verificationOutput).toContain('42 files passed');
      expect(result.verificationOutput).toContain('Tests: 2 passed');
    });
  });
});

describe('detectVerifyScript', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ralphctl-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('detects npm scripts from package.json', () => {
    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({
        scripts: {
          lint: 'eslint .',
          typecheck: 'tsc --noEmit',
          test: 'vitest',
        },
      })
    );

    const result = detectVerifyScript(tempDir);
    expect(result).toBe('npm run lint && npm run typecheck && npm run test');
  });

  it('detects npm with only lint script', () => {
    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({
        scripts: {
          lint: 'eslint .',
        },
      })
    );

    const result = detectVerifyScript(tempDir);
    expect(result).toBe('npm run lint');
  });

  it('detects Python projects', () => {
    writeFileSync(join(tempDir, 'pyproject.toml'), '[tool.pytest]');

    const result = detectVerifyScript(tempDir);
    expect(result).toBe('pytest');
  });

  it('detects Go projects', () => {
    writeFileSync(join(tempDir, 'go.mod'), 'module example.com/test');

    const result = detectVerifyScript(tempDir);
    expect(result).toBe('go test ./...');
  });

  it('detects Rust projects', () => {
    writeFileSync(join(tempDir, 'Cargo.toml'), '[package]');

    const result = detectVerifyScript(tempDir);
    expect(result).toBe('cargo test');
  });

  it('detects Gradle projects', () => {
    writeFileSync(join(tempDir, 'build.gradle'), 'plugins {}');

    const result = detectVerifyScript(tempDir);
    expect(result).toBe('./gradlew check');
  });

  it('detects Maven projects', () => {
    writeFileSync(join(tempDir, 'pom.xml'), '<project></project>');

    const result = detectVerifyScript(tempDir);
    expect(result).toBe('mvn verify');
  });

  it('detects Makefile projects', () => {
    writeFileSync(join(tempDir, 'Makefile'), 'check:\n\techo "checking"');

    const result = detectVerifyScript(tempDir);
    expect(result).toBe('make check || make test');
  });

  it('returns null for unknown project type', () => {
    const result = detectVerifyScript(tempDir);
    expect(result).toBeNull();
  });

  it('returns null for package.json without relevant scripts', () => {
    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({
        scripts: {
          start: 'node index.js',
          build: 'tsc',
        },
      })
    );

    const result = detectVerifyScript(tempDir);
    expect(result).toBeNull();
  });
});

describe('getEffectiveVerifyScript', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ralphctl-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('uses explicit project verifyScript when available', () => {
    const project: Project = {
      name: 'test',
      displayName: 'Test',
      repositories: [{ name: 'test', path: tempDir }],
      verifyScript: 'custom-verify-command',
    };

    // Even if there's a package.json, explicit script takes priority
    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({
        scripts: { test: 'jest' },
      })
    );

    const result = getEffectiveVerifyScript(project, tempDir);
    expect(result).toBe('custom-verify-command');
  });

  it('falls back to auto-detection when no explicit script', () => {
    const project: Project = {
      name: 'test',
      displayName: 'Test',
      repositories: [{ name: 'test', path: tempDir }],
    };

    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({
        scripts: { test: 'jest' },
      })
    );

    const result = getEffectiveVerifyScript(project, tempDir);
    expect(result).toBe('npm run test');
  });

  it('returns null when no project and no detection', () => {
    const result = getEffectiveVerifyScript(undefined, tempDir);
    expect(result).toBeNull();
  });
});

describe('getRecentGitHistory', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ralphctl-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns error message for non-git directory', () => {
    const result = getRecentGitHistory(tempDir);
    expect(result).toContain('Unable to retrieve git history');
  });

  it('returns error message for non-existent directory', () => {
    const result = getRecentGitHistory('/nonexistent/path/that/does/not/exist');
    expect(result).toContain('Unable to retrieve git history');
  });
});
