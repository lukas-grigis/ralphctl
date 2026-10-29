/**
 * Permission intent for one AI session call — semantic gates, never tool names; each adapter
 * translates them to its CLI's vocabulary, and where the CLI's gate is coarser it maps to the
 * nearest mode and names the over-grant at the mapping site (codex's `CODEX_SANDBOX`).
 *
 * Permissions gate the **capability surface**, not **paths**: path scope is the topology of `cwd`
 * + `additionalRoots` (+ `outputDir`) in {@link AiSession}, and topology is the primary defense.
 * Creating a file must stay possible under every profile, because each contract-path leaf lands a
 * `signals.json` in `outputDir`; to keep the AI out of a tree, don't mount it. See
 * `.claude/docs/SECURITY.md`.
 */
export interface SessionPermissions {
  /** When `false`, the AI may not modify existing files (creating `signals.json` stays possible). */
  readonly canModifyRepoFiles: boolean;
  /** When `false`, the AI must not run shell commands. Denies Claude `Bash`, Copilot `shell`. */
  readonly canRunShell: boolean;
  /** When `false`, the AI must not reach the network. Denies `WebFetch` / `WebSearch`. */
  readonly canAccessNetwork: boolean;
  /**
   * When `true`, the adapter may auto-accept edits / shell invocations; otherwise the CLI's own
   * default approval policy applies (usually interactive prompting).
   */
  readonly autoApprove: boolean;
}

/** Every non-implement headless chain (refine, plan, ideate, readiness, detect-*): no edits, no shell. */
export const READ_ONLY: SessionPermissions = {
  canModifyRepoFiles: false,
  canRunShell: false,
  canAccessNetwork: true,
  autoApprove: false,
};

/** Implement (generator + evaluator) and apply-feedback. */
export const FULL_AUTO: SessionPermissions = {
  canModifyRepoFiles: true,
  canRunShell: true,
  canAccessNetwork: true,
  autoApprove: true,
};
