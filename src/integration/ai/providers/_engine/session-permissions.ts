/**
 * Permission intent for one AI session call.
 *
 * Intent, not mechanism — the port speaks semantic gates; each adapter translates them to
 * its tool-name vocabulary (Claude `--disallowedTools`, Copilot `--deny-tool=`, Codex
 * sandbox modes). The minute the domain port speaks tool-specific names, the next adapter
 * has to translate-and-pretend; resist.
 *
 * ## What permissions DO and DON'T gate
 *
 * Permissions gate the AI's **capability surface** — which classes of tools it may invoke.
 * They do NOT gate **paths**. Path scope is the topology of `cwd` + `additionalRoots` in
 * {@link AiSession}: a file the AI cannot reach is one outside cwd and not mounted via
 * --add-dir. Topology is the primary defense; permissions are the secondary capability
 * filter.
 *
 * ## Write tool is always allowed
 *
 * Every contract-path leaf (audit-[09]) requires the AI to land a `signals.json` envelope
 * in its `outputDir` via the Write tool. The Write tool therefore stays allowed regardless
 * of `canModifyRepoFiles`. To prevent writes to a particular tree, don't mount it
 * (don't list it in `additionalRoots`).
 *
 * ## Profile mapping
 *
 *  - {@link READ_ONLY} (`canModifyRepoFiles=false`, no shell): refine, plan, ideate,
 *    readiness, detect-scripts, detect-skills. The AI may read whatever cwd / additionalRoots
 *    expose, and may write signals.json to outputDir, but Edit / MultiEdit / Bash are denied.
 *  - {@link FULL_AUTO}: implement (generator + evaluator) and apply-feedback (review). The
 *    AI may modify any file in the cwd / additionalRoots topology + run shell commands.
 */
export interface SessionPermissions {
  /**
   * When `false`, deny `Edit` / `MultiEdit` / `NotebookEdit` tools — the AI cannot modify
   * existing files. The `Write` tool stays open so signals.json (the contract envelope) can
   * land in `outputDir`; path scope (cwd + additionalRoots) is what keeps the AI from
   * Writing into trees it shouldn't touch.
   */
  readonly canModifyRepoFiles: boolean;
  /** When `false`, the AI must not run shell commands. Denies Claude `Bash`, Copilot `shell`. */
  readonly canRunShell: boolean;
  /** When `false`, the AI must not reach the network. Denies `WebFetch` / `WebSearch`. */
  readonly canAccessNetwork: boolean;
  /**
   * When `true`, the adapter may auto-accept edits / shell invocations. Without this,
   * the adapter still respects whatever default approval policy the underlying CLI
   * uses (usually interactive prompting — not what an autonomous chain wants).
   */
  readonly autoApprove: boolean;
}

/**
 * Read-only profile — used by every non-implement headless chain. The AI may write the
 * audit-[09] `signals.json` envelope to its `outputDir` (Write tool is always permitted)
 * but cannot Edit existing files or run shell commands. Path scope (cwd + additionalRoots)
 * defines what the AI can actually see / write to.
 */
export const READ_ONLY: SessionPermissions = {
  canModifyRepoFiles: false,
  canRunShell: false,
  canAccessNetwork: true,
  autoApprove: false,
};

/** Full-auto profile used by the implement chain. */
export const FULL_AUTO: SessionPermissions = {
  canModifyRepoFiles: true,
  canRunShell: true,
  canAccessNetwork: true,
  autoApprove: true,
};
