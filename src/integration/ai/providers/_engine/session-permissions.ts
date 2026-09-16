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
 * ## Creating a file is always possible
 *
 * Every contract-path leaf (audit-[09]) requires the AI to land a `signals.json` envelope in its
 * `outputDir`, so every profile must leave it SOME way to create that file, regardless of
 * `canModifyRepoFiles`. Four backends satisfy that by keeping the `Write` tool open; Grok has no
 * `write` tool at all (`Write` / `Edit` / `MultiEdit` are aliases of `search_replace`, the only
 * tool that can create a file), so it scopes its edit deny rule to `--cwd` instead and leaves the
 * session directory outside it writable. The rule is the intent, not the mechanism — an adapter
 * that denies file creation outright cannot satisfy the contract. To prevent writes to a
 * particular tree, don't mount it (don't list it in `additionalRoots`).
 *
 * ## Profile mapping
 *
 *  - {@link READ_ONLY} (`canModifyRepoFiles=false`, no shell): refine, plan, ideate,
 *    readiness, detect-scripts, detect-skills. The AI may read whatever cwd / additionalRoots
 *    expose, and may write signals.json to outputDir, but Edit / MultiEdit / Bash are denied.
 *  - {@link FULL_AUTO}: implement (generator + evaluator) and apply-feedback (review). The
 *    AI may modify any file in the cwd / additionalRoots topology + run shell commands.
 *
 * ## When a CLI's gate is coarser than these booleans
 *
 * Not every underlying CLI exposes a permission gate this granular. When a CLI's native modes
 * don't line up one-to-one with `canModifyRepoFiles` / `canRunShell` / `canAccessNetwork`, the
 * adapter maps to the nearest supported mode and documents the resulting over-grant or
 * under-grant inline, at the mapping site — never by adding a tool-specific field here (see the
 * port-not-mechanism rule above). The reference precedent is the codex adapter's `sandboxFor`
 * (`providers/codex/headless.ts`): Codex `exec` has only `read-only` (blocks the mandatory
 * `signals.json` write, so it's unusable under audit-[09]) and `workspace-write` (allows any
 * write inside the mounted topology). Every codex profile therefore maps to `workspace-write`,
 * which over-grants relative to `canModifyRepoFiles=false` — the comment beside `sandboxFor`
 * names this explicitly and defers to cwd + `additionalRoots` + `outputDir` as the real
 * boundary, exactly as the topology-over-permissions note above describes.
 */
export interface SessionPermissions {
  /**
   * When `false`, deny `Edit` / `MultiEdit` / `NotebookEdit` tools — the AI cannot modify
   * existing files. Creating signals.json (the contract envelope) in `outputDir` stays possible
   * either way — four backends keep the `Write` tool open, Grok scopes its edit deny rule to
   * `--cwd` — and path scope (cwd + additionalRoots) is what keeps the AI out of trees it
   * shouldn't touch.
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
 * Read-only profile — used by every non-implement headless chain. The AI may create the
 * audit-[09] `signals.json` envelope in its `outputDir` (every adapter leaves that possible)
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
