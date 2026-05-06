/**
 * `ExternalPort` — adapters for tools the harness shells out to: `git`,
 * `gh`/`glab`, issue trackers, and per-repo check-script execution.
 *
 * Methods that mutate filesystem state (`hardResetWorkingTree`,
 * `createAndCheckoutBranch`, `stashChanges`) return
 * `Promise<Result<void, StorageError>>` — they can fail in ways the
 * harness must surface to the caller (missing git identity, dirty index,
 * etc.).
 *
 * Pure-read methods (`hasUncommittedChanges`, `getCurrentBranch`,
 * `verifyBranch`, `getHeadSha`, `getChangedFilesSince`,
 * `getRecentGitHistory`, `isValidBranchName`, `generateBranchName`) stay
 * synchronous and total — they return sensible defaults when the repo
 * isn't usable rather than throwing.
 */
import type { StorageError } from '@src/domain/errors/storage-error.ts';
import type { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/values/absolute-path.ts';

/** Issue data fetched from an external tracker (GitHub, GitLab, …). */
export interface ExternalIssue {
  readonly title: string;
  readonly body: string;
  readonly state: string;
  readonly comments: readonly { readonly author: string; readonly body: string }[];
}

/** Result of running a check / lifecycle script. */
export interface CheckScriptResult {
  readonly passed: boolean;
  readonly output: string;
}

/** Phase tag describing which lifecycle hook the check script was invoked from. */
export type CheckScriptPhase = 'post-task' | 'feedback';

/** Inputs for {@link ExternalPort.createPullRequest}. */
export interface CreatePullRequestInput {
  readonly cwd: AbsolutePath;
  /** Source branch (the sprint branch). */
  readonly branch: string;
  /** Target branch on the remote (e.g. `main`). */
  readonly base: string;
  readonly title: string;
  readonly body: string;
  readonly draft?: boolean;
}

/** Output of {@link ExternalPort.createPullRequest}. */
export interface CreatePullRequestOutput {
  /** The published PR / MR URL. */
  readonly url: string;
}

export interface ExternalPort {
  // --- Issue tracker ---

  /**
   * Fetch issue data from a URL (GitHub, GitLab, …).
   *
   *  - `Result.ok(issue)`   — issue resolved.
   *  - `Result.ok(null)`    — URL is well-formed but the issue does not
   *                           exist (e.g. 404). A normal "no such thing"
   *                           outcome, not a failure.
   *  - `Result.error(err)`  — network / parse / auth failure.
   */
  fetchIssue(url: string): Promise<Result<ExternalIssue | null, StorageError>>;

  /** Format issue data as context for AI prompts. */
  formatIssueContext(issue: ExternalIssue): string;

  // --- Setup / check script execution ---

  /**
   * Run a one-shot environment setup script (e.g. `pnpm install`) in a
   * project directory once at sprint start. Distinct from
   * {@link ExternalPort.runCheckScript} — setup prepares the environment;
   * check verifies the working tree after a task. They share the same
   * underlying shell-execution machinery but are emitted at different
   * lifecycle hooks. `timeout` overrides the default
   * `RALPHCTL_SETUP_TIMEOUT_MS`.
   */
  runSetupScript(projectPath: AbsolutePath, script: string, timeout?: number): Promise<CheckScriptResult>;

  /**
   * Run a check / lifecycle script in a project directory.
   * `timeout` overrides the default `RALPHCTL_SETUP_TIMEOUT_MS`.
   */
  runCheckScript(
    projectPath: AbsolutePath,
    script: string,
    phase: CheckScriptPhase,
    timeout?: number
  ): Promise<CheckScriptResult>;

  // --- Git: read-only ---

  /** True iff the working tree has unstaged or untracked changes. */
  hasUncommittedChanges(projectPath: AbsolutePath): boolean;

  /** Currently checked-out branch. Empty string when not in a git repo. */
  getCurrentBranch(projectPath: AbsolutePath): string;

  /** True iff the repo is on the expected branch. */
  verifyBranch(projectPath: AbsolutePath, expected: string): boolean;

  /** HEAD SHA, or `null` if `projectPath` isn't a git repo. */
  getHeadSha(projectPath: AbsolutePath): string | null;

  /**
   * Files changed in the working tree relative to a baseline commit.
   * Includes committed changes (`git diff --name-only <baseline>..HEAD`)
   * AND unstaged + staged working-tree changes (`git status --porcelain`).
   * Returns `[]` when the repo isn't a git repo, the baseline is
   * unresolvable, or there are genuinely no changes — never throws.
   */
  getChangedFilesSince(projectPath: AbsolutePath, baselineSha: string): readonly string[];

  /** Recent git log for context building. */
  getRecentGitHistory(projectPath: AbsolutePath, count: number): string;

  /** Generate a sprint-derived branch name (`ralphctl/<sprint-id>`). */
  generateBranchName(sprintId: string): string;

  /** True iff the string is a valid git branch name. */
  isValidBranchName(name: string): boolean;

  // --- Git: mutating ---

  /**
   * Hard-reset the working tree to HEAD and remove untracked files.
   *
   * Destructive — only invoke on explicit user consent (`--reset-on-resume`
   * flag, dirty-tree recovery confirm prompt, etc.).
   */
  hardResetWorkingTree(projectPath: AbsolutePath): Promise<Result<void, StorageError>>;

  /** Create and / or checkout a branch in a repo. */
  createAndCheckoutBranch(projectPath: AbsolutePath, branchName: string): Promise<Result<void, StorageError>>;

  /**
   * `git stash push -u -m <message>` — preserves uncommitted + untracked
   * changes so a clean working tree can be guaranteed before sprint start.
   *
   * Returns `Result.error(StorageError({ subCode: 'no-changes' }))` when
   * the working tree is already clean (callers treat as a no-op). Other
   * stash failures (e.g. unmerged paths) propagate as `subCode: 'io'`.
   *
   * The stash entry is persisted in the repo's `git stash list` — `git
   * stash pop` recovers it. Callers are responsible for surfacing the
   * stash message to the user so they can find it again later.
   */
  stashChanges(projectPath: AbsolutePath, message: string): Promise<Result<void, StorageError>>;

  /**
   * Stage every change in the working tree (`git add -A`) and create a
   * commit with the supplied message. Resolves to the new HEAD SHA on
   * success.
   *
   *  - `Result.error(StorageError({ subCode: 'no-changes' }))` — the tree
   *    was clean; nothing to commit. Callers treat this as a no-op.
   *  - `Result.error(StorageError({ subCode: 'io' }))` — the underlying
   *    git invocation failed.
   *
   * The message is passed through `git`'s argv (no shell), so special
   * characters are preserved verbatim. Callers should defensively
   * truncate / sanitise long messages before invoking.
   */
  commitChanges(projectPath: AbsolutePath, message: string): Promise<Result<string, StorageError>>;

  // --- Pull / merge requests ---

  /**
   * Open a pull / merge request for the given branch using the platform CLI
   * detected from the repo's git remote (`gh` for GitHub, `glab` for GitLab).
   *
   * Returns `Result.error(StorageError({ subCode: 'io', ... }))` when:
   *  - the platform CLI is not installed,
   *  - the remote URL is not recognised,
   *  - the underlying CLI exits non-zero,
   *  - or the CLI succeeds but emits no parseable URL.
   */
  createPullRequest(input: CreatePullRequestInput): Promise<Result<CreatePullRequestOutput, StorageError>>;
}
