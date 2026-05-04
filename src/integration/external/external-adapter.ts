/**
 * `DefaultExternalAdapter` — composes the focused helpers in this folder
 * into a single {@link ExternalPort} implementation.
 *
 * The adapter itself is a thin delegating layer; all behaviour lives in
 * {@link GitOperations}, {@link CheckScriptRunner}, {@link IssueFetcher},
 * and the pure {@link branchName} module. The composition root wires the
 * concrete dependencies (real `NodeGitRunner` etc.) and tests can swap
 * them for fakes.
 */
import type {
  CheckScriptPhase,
  CheckScriptResult,
  CreatePullRequestInput,
  CreatePullRequestOutput,
  ExternalIssue,
  ExternalPort,
} from '@src/business/ports/external-port.ts';
import { StorageError } from '@src/domain/errors/storage-error.ts';
import { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import {
  generateBranchName as generateBranchNameImpl,
  isValidBranchName as isValidBranchNameImpl,
} from './branch-name.ts';
import type { CheckScriptRunner } from './check-script-runner.ts';
import type { GitOperations } from './git-operations.ts';
import type { IssueFetcher } from './issue-fetcher.ts';
import { PullRequestRunner } from './pull-request-runner.ts';

export class DefaultExternalAdapter implements ExternalPort {
  constructor(
    private readonly git: GitOperations,
    private readonly checkScripts: CheckScriptRunner,
    private readonly issues: IssueFetcher,
    private readonly pullRequests: PullRequestRunner = new PullRequestRunner()
  ) {}

  // --- Issue tracker --------------------------------------------------

  fetchIssue(url: string): Promise<Result<ExternalIssue | null, StorageError>> {
    return this.issues.fetch(url);
  }

  formatIssueContext(issue: ExternalIssue): string {
    return this.issues.format(issue);
  }

  // --- Check script execution -----------------------------------------

  async runCheckScript(
    projectPath: AbsolutePath,
    script: string,
    phase: CheckScriptPhase,
    timeout?: number
  ): Promise<CheckScriptResult> {
    const r = await this.checkScripts.run(projectPath, script, phase, timeout);
    if (r.ok) return r.value;
    // System-level failure — surface as a failed gate with the error
    // message so the caller's existing handling (ResultCard) can render
    // it. Keeping the port method non-Result preserves the simple
    return { passed: false, output: `[check-script error: ${r.error.message}]` };
  }

  // --- Git: read-only -------------------------------------------------

  hasUncommittedChanges(projectPath: AbsolutePath): boolean {
    return this.git.hasUncommittedChanges(projectPath);
  }

  getCurrentBranch(projectPath: AbsolutePath): string {
    return this.git.getCurrentBranch(projectPath);
  }

  verifyBranch(projectPath: AbsolutePath, expected: string): boolean {
    return this.git.verifyBranch(projectPath, expected);
  }

  getHeadSha(projectPath: AbsolutePath): string | null {
    return this.git.getHeadSha(projectPath);
  }

  getChangedFilesSince(projectPath: AbsolutePath, baselineSha: string): readonly string[] {
    return this.git.getChangedFilesSince(projectPath, baselineSha);
  }

  getRecentGitHistory(projectPath: AbsolutePath, count: number): string {
    return this.git.getRecentGitHistory(projectPath, count);
  }

  generateBranchName(sprintId: string): string {
    return generateBranchNameImpl(sprintId);
  }

  isValidBranchName(name: string): boolean {
    return isValidBranchNameImpl(name);
  }

  // --- Git: mutating --------------------------------------------------

  hardResetWorkingTree(projectPath: AbsolutePath): Promise<Result<void, StorageError>> {
    return this.git.hardResetWorkingTree(projectPath);
  }

  createAndCheckoutBranch(projectPath: AbsolutePath, branchName: string): Promise<Result<void, StorageError>> {
    return this.git.createAndCheckoutBranch(projectPath, branchName);
  }

  stashChanges(projectPath: AbsolutePath, message: string): Promise<Result<void, StorageError>> {
    return this.git.stashChanges(projectPath, message);
  }

  commitChanges(projectPath: AbsolutePath, message: string): Promise<Result<string, StorageError>> {
    return this.git.commitChanges(projectPath, message);
  }

  // --- Pull / merge requests -----------------------------------------

  createPullRequest(input: CreatePullRequestInput): Promise<Result<CreatePullRequestOutput, StorageError>> {
    const remoteUrl = this.git.getRemoteUrl(input.cwd);
    if (remoteUrl === null) {
      return Promise.resolve(
        Result.error(
          new StorageError({
            subCode: 'io',
            message: `no 'origin' remote configured at ${input.cwd}`,
          })
        )
      );
    }
    const result = this.pullRequests.create({
      cwd: input.cwd,
      remoteUrl,
      branch: input.branch,
      base: input.base,
      title: input.title,
      body: input.body,
      ...(input.draft !== undefined ? { draft: input.draft } : {}),
    });
    if (!result.ok) return Promise.resolve(Result.error(result.error));
    return Promise.resolve(Result.ok<CreatePullRequestOutput>({ url: result.value.url }));
  }
}
