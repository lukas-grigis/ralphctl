import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getEffectiveVerifyScript, getRecentGitHistory } from './task-context.ts';
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

describe('getEffectiveVerifyScript', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ralphctl-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('uses explicit repository verifyScript when available', () => {
    const project: Project = {
      name: 'test',
      displayName: 'Test',
      repositories: [{ name: 'test', path: tempDir, verifyScript: 'custom-verify-command' }],
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

  it('returns null when no explicit script (no runtime auto-detection)', () => {
    const project: Project = {
      name: 'test',
      displayName: 'Test',
      repositories: [{ name: 'test', path: tempDir }],
    };

    // package.json exists but no explicit verifyScript — should return null
    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({
        scripts: { test: 'jest' },
      })
    );

    const result = getEffectiveVerifyScript(project, tempDir);
    expect(result).toBeNull();
  });

  it('returns null when no project', () => {
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
