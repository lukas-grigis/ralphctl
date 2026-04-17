/** Issue data fetched from an external tracker */
export interface ExternalIssue {
  title: string;
  body: string;
  state: string;
  comments: { author: string; body: string }[];
}

/** Result of running a check/lifecycle script */
export interface CheckScriptResult {
  passed: boolean;
  output: string;
}

/** Port for external service integrations */
export interface ExternalPort {
  /** Fetch issue data from a URL (GitHub, GitLab, etc.) */
  fetchIssue(url: string): Promise<ExternalIssue | null>;

  /** Format issue data as context for AI prompts */
  formatIssueContext(issue: ExternalIssue): string;

  /** Detect project tooling (subagents, MCP servers, skills) in given paths */
  detectProjectTooling(paths: string[]): string;

  // --- Check script execution ---

  /** Run a check/lifecycle script in a project directory */
  runCheckScript(projectPath: string, script: string, phase: string, timeout?: number): CheckScriptResult;

  // --- Git operations ---

  /** Check if a repo has uncommitted changes */
  hasUncommittedChanges(projectPath: string): boolean;

  /** Create and/or checkout a branch in a repo */
  createAndCheckoutBranch(projectPath: string, branchName: string): void;

  /** Get the current branch name in a repo */
  getCurrentBranch(projectPath: string): string;

  /** Verify repo is on the expected branch */
  verifyBranch(projectPath: string, expected: string): boolean;

  /** Get HEAD SHA of a repo (null if not a git repo) */
  getHeadSha(projectPath: string): string | null;

  /** Get recent git log for context building */
  getRecentGitHistory(projectPath: string, count: number): string;

  /** Generate a branch name from sprint ID */
  generateBranchName(sprintId: string): string;

  /** Check if a branch name is valid */
  isValidBranchName(name: string): boolean;
}
