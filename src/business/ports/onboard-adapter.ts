/**
 * Port for the onboarding pipeline's filesystem + discovery surface.
 *
 * Every integration-specific operation the onboard pipeline needs is bundled
 * here so business/pipelines/onboard.ts can stay inside the Clean Architecture
 * fence: the pipeline imports only the port, and concrete adapters (file I/O,
 * AI discovery) are wired in at the composition root.
 */

import type { AiProvider } from '@src/domain/models.ts';

export interface LintViolation {
  readonly rule: string;
  readonly message: string;
}

export interface ExistingInstructions {
  /** Full instructions file body on disk, or `null` when absent. */
  content: string | null;
  /**
   * `true` when the file was authored by the user (missing the harness
   * marker). Authored content is preserved by the adopt/update flows.
   */
  authored: boolean;
}

export interface AgentsMdDiscoveryInput {
  repoPath: string;
  mode: 'bootstrap' | 'adopt' | 'update';
  existingAgentsMd: string | null;
  projectType: string;
  checkScriptSuggestion: string;
  /** File name the AI should name in its proposal (e.g. `CLAUDE.md`). */
  fileName: string;
}

export interface AgentsMdDiscoveryResult {
  agentsMd: string | null;
  checkScript: string | null;
  changes: string | null;
}

export interface WriteInstructionsResult {
  /** Absolute path of the written file. */
  path: string;
}

export interface RepoPathValidation {
  /** Path exists on disk AND is a directory. `false` for missing paths or files. */
  exists: boolean;
  /** Path contains a `.git` entry (directory or file — worktrees use a file). */
  isGitRepo: boolean;
}

/** Functional seam for every integration operation the onboard pipeline needs. */
export interface OnboardAdapterPort {
  /** Read the provider-native instructions file (if any) and classify as authored/managed. */
  readExistingInstructions(repoPath: string, provider: AiProvider): ExistingInstructions;

  /** Validate that `path` exists as a directory and contains a `.git` entry. */
  validateRepoPath(path: string): RepoPathValidation;

  /** Run the structural + readability lint against a proposed instructions body. */
  lintAgentsMd(content: string): { ok: boolean; violations: LintViolation[] };

  /** Best-effort drift scan — warns when cited commands don't resolve in the repo. */
  detectCommandDrift(content: string, repoPath: string): string[];

  /** Ask the configured AI provider to produce a repo-instructions + check script proposal. */
  discoverAgentsMd(input: AgentsMdDiscoveryInput): Promise<AgentsMdDiscoveryResult>;

  /** Infer a coarse project type from top-level config files. */
  inferProjectType(repoPath: string): string;

  /**
   * Atomically write the provider-native instructions file. For `claude`
   * this is `CLAUDE.md` at the repo root; for `copilot` this is
   * `.github/copilot-instructions.md` (parent dir created if missing).
   */
  writeProviderInstructions(repoPath: string, content: string, provider: AiProvider): WriteInstructionsResult;
}
