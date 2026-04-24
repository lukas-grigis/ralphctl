import type { ExternalPort, ExternalIssue, CheckScriptResult } from '@src/business/ports/external.ts';
import { fetchIssueFromUrl, formatIssueContext } from '@src/integration/external/issue-fetch.ts';
import { buildProjectToolingSection } from '@src/integration/ai/project-tooling.ts';
import { runLifecycleHook, type LifecycleEvent } from '@src/integration/external/lifecycle.ts';
import { getRecentGitHistory } from '@src/integration/ai/task-context.ts';
import {
  hasUncommittedChanges as gitHasUncommittedChanges,
  hardResetWorkingTree as gitHardResetWorkingTree,
  autoCommit as gitAutoCommit,
  createAndCheckoutBranch as gitCreateAndCheckoutBranch,
  getCurrentBranch as gitGetCurrentBranch,
  verifyCurrentBranch,
  getHeadSha as gitGetHeadSha,
  generateBranchName as gitGenerateBranchName,
  isValidBranchName as gitIsValidBranchName,
} from '@src/integration/external/git.ts';

export class DefaultExternalAdapter implements ExternalPort {
  fetchIssue(url: string): Promise<ExternalIssue | null> {
    // fetchIssueFromUrl is synchronous but returns null for unrecognized URLs
    const data = fetchIssueFromUrl(url);
    if (!data) {
      return Promise.resolve(null);
    }

    return Promise.resolve({
      title: data.title,
      body: data.body,
      state: '', // Not available from the current fetch API
      comments: data.comments.map((c) => ({
        author: c.author,
        body: c.body,
      })),
    });
  }

  formatIssueContext(issue: ExternalIssue): string {
    // Bridge ExternalIssue to the IssueData format expected by formatIssueContext
    return formatIssueContext({
      title: issue.title,
      body: issue.body,
      comments: issue.comments.map((c) => ({
        author: c.author,
        createdAt: '',
        body: c.body,
      })),
      url: '',
    });
  }

  detectProjectTooling(paths: string[]): string {
    return buildProjectToolingSection(paths);
  }

  // --- Check script execution ---

  runCheckScript(projectPath: string, script: string, phase: string, timeout?: number): Promise<CheckScriptResult> {
    return runLifecycleHook(projectPath, script, phase as LifecycleEvent, timeout);
  }

  // --- Git operations ---

  hasUncommittedChanges(projectPath: string): boolean {
    return gitHasUncommittedChanges(projectPath);
  }

  hardResetWorkingTree(projectPath: string): void {
    gitHardResetWorkingTree(projectPath);
  }

  autoCommit(projectPath: string, message: string): Promise<void> {
    gitAutoCommit(projectPath, message);
    return Promise.resolve();
  }

  createAndCheckoutBranch(projectPath: string, branchName: string): void {
    gitCreateAndCheckoutBranch(projectPath, branchName);
  }

  getCurrentBranch(projectPath: string): string {
    return gitGetCurrentBranch(projectPath);
  }

  verifyBranch(projectPath: string, expected: string): boolean {
    return verifyCurrentBranch(projectPath, expected);
  }

  getHeadSha(projectPath: string): string | null {
    return gitGetHeadSha(projectPath);
  }

  getRecentGitHistory(projectPath: string, count: number): string {
    return getRecentGitHistory(projectPath, count);
  }

  generateBranchName(sprintId: string): string {
    return gitGenerateBranchName(sprintId);
  }

  isValidBranchName(name: string): boolean {
    return gitIsValidBranchName(name);
  }
}
