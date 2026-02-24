import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  branchExists,
  createAndCheckoutBranch,
  generateBranchName,
  getCurrentBranch,
  getDefaultBranch,
  hasUncommittedChanges,
  isValidBranchName,
  verifyCurrentBranch,
} from './git.ts';
import { writeFileSync } from 'node:fs';

describe('isValidBranchName', () => {
  it('accepts valid branch names', () => {
    expect(isValidBranchName('main')).toBe(true);
    expect(isValidBranchName('feature/my-branch')).toBe(true);
    expect(isValidBranchName('ralphctl/20260224-143200-auth-feature')).toBe(true);
    expect(isValidBranchName('fix_bug-123')).toBe(true);
    expect(isValidBranchName('v1.0.0')).toBe(true);
  });

  it('rejects empty or too-long names', () => {
    expect(isValidBranchName('')).toBe(false);
    expect(isValidBranchName('a'.repeat(251))).toBe(false);
  });

  it('rejects names with invalid characters', () => {
    expect(isValidBranchName('branch name')).toBe(false);
    expect(isValidBranchName('branch~name')).toBe(false);
    expect(isValidBranchName('branch^name')).toBe(false);
    expect(isValidBranchName('branch:name')).toBe(false);
    expect(isValidBranchName('branch?name')).toBe(false);
    expect(isValidBranchName('branch*name')).toBe(false);
    expect(isValidBranchName('branch[name')).toBe(false);
    expect(isValidBranchName('branch\\name')).toBe(false);
  });

  it('rejects names with invalid patterns', () => {
    expect(isValidBranchName('branch..name')).toBe(false);
    expect(isValidBranchName('branch.')).toBe(false);
    expect(isValidBranchName('branch/')).toBe(false);
    expect(isValidBranchName('branch.lock')).toBe(false);
    expect(isValidBranchName('-branch')).toBe(false);
    expect(isValidBranchName('branch//name')).toBe(false);
  });
});

describe('generateBranchName', () => {
  it('generates ralphctl/<sprint-id> format', () => {
    expect(generateBranchName('20260224-143200-auth-feature')).toBe('ralphctl/20260224-143200-auth-feature');
  });
});

describe('git operations with temp repo', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ralphctl-git-test-'));
    execSync('git init', { cwd: tempDir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: tempDir, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: tempDir, stdio: 'pipe' });
    // Create initial commit so HEAD exists
    writeFileSync(join(tempDir, 'README.md'), '# Test');
    execSync('git add . && git commit -m "init"', { cwd: tempDir, stdio: 'pipe' });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('getCurrentBranch', () => {
    it('returns the current branch name', () => {
      const branch = getCurrentBranch(tempDir);
      // Default branch varies; accept master or main
      expect(['main', 'master']).toContain(branch);
    });
  });

  describe('branchExists', () => {
    it('returns true for existing branch', () => {
      const current = getCurrentBranch(tempDir);
      expect(branchExists(tempDir, current)).toBe(true);
    });

    it('returns false for non-existing branch', () => {
      expect(branchExists(tempDir, 'nonexistent-branch')).toBe(false);
    });

    it('throws on invalid branch name', () => {
      expect(() => branchExists(tempDir, 'bad name')).toThrow('Invalid branch name');
    });
  });

  describe('createAndCheckoutBranch', () => {
    it('creates and checks out a new branch', () => {
      createAndCheckoutBranch(tempDir, 'ralphctl/test-sprint');
      expect(getCurrentBranch(tempDir)).toBe('ralphctl/test-sprint');
    });

    it('is idempotent — no-op if already on the branch', () => {
      createAndCheckoutBranch(tempDir, 'ralphctl/test-sprint');
      // Calling again should not throw
      createAndCheckoutBranch(tempDir, 'ralphctl/test-sprint');
      expect(getCurrentBranch(tempDir)).toBe('ralphctl/test-sprint');
    });

    it('checks out existing branch if already created', () => {
      // Create branch, switch away, then switch back
      createAndCheckoutBranch(tempDir, 'ralphctl/test-sprint');
      execSync('git checkout -b temp-branch', { cwd: tempDir, stdio: 'pipe' });
      createAndCheckoutBranch(tempDir, 'ralphctl/test-sprint');
      expect(getCurrentBranch(tempDir)).toBe('ralphctl/test-sprint');
    });

    it('throws on invalid branch name', () => {
      expect(() => {
        createAndCheckoutBranch(tempDir, 'bad name');
      }).toThrow('Invalid branch name');
    });
  });

  describe('verifyCurrentBranch', () => {
    it('returns true when on expected branch', () => {
      createAndCheckoutBranch(tempDir, 'ralphctl/test-sprint');
      expect(verifyCurrentBranch(tempDir, 'ralphctl/test-sprint')).toBe(true);
    });

    it('returns false when on different branch', () => {
      expect(verifyCurrentBranch(tempDir, 'nonexistent-branch')).toBe(false);
    });
  });

  describe('hasUncommittedChanges', () => {
    it('returns false for clean repo', () => {
      expect(hasUncommittedChanges(tempDir)).toBe(false);
    });

    it('returns true for untracked file', () => {
      writeFileSync(join(tempDir, 'new-file.txt'), 'content');
      expect(hasUncommittedChanges(tempDir)).toBe(true);
    });

    it('returns true for staged changes', () => {
      writeFileSync(join(tempDir, 'README.md'), '# Updated');
      execSync('git add .', { cwd: tempDir, stdio: 'pipe' });
      expect(hasUncommittedChanges(tempDir)).toBe(true);
    });
  });

  describe('getDefaultBranch', () => {
    it('detects default branch', () => {
      const branch = getDefaultBranch(tempDir);
      // In a fresh repo without remote, falls back to checking local branches
      expect(['main', 'master']).toContain(branch);
    });
  });
});
