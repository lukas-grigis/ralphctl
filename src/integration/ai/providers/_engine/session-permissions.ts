/**
 * Permission intent for one AI session call.
 *
 * Intent, not mechanism. The port speaks `canRunShell: boolean` (semantic), the adapter
 * translates that to its tool-name vocabulary (`'Bash'`, `'Edit'`, etc.). The minute the
 * domain port speaks Claude-specific tool names, the next adapter has to translate-and-
 * pretend; resist.
 *
 * Each chain composes the combination it needs:
 *
 *  - Read-only chains (refine, plan, readiness) → all `false` except `canAccessNetwork`.
 *  - Implement chain → all `true`, including `autoApprove`.
 *
 * Adapter mapping highlights:
 *  - `autoApprove && canEditFiles && canRunShell` → Claude `--permission-mode acceptEdits`.
 *  - read-only (none of the three above) → Claude `--permission-mode plan` (closest
 *    available; revisit if a stricter flag becomes available).
 */
export interface SessionPermissions {
  /** When `false`, the AI must not modify the working tree. */
  readonly canEditFiles: boolean;
  /** When `false`, the AI must not run shell commands. */
  readonly canRunShell: boolean;
  /** When `false`, the AI must not reach the network. */
  readonly canAccessNetwork: boolean;
  /**
   * When `true`, the adapter may auto-accept edits / shell invocations. Without this,
   * the adapter still respects whatever default approval policy the underlying CLI
   * uses (usually interactive prompting — not what an autonomous chain wants).
   */
  readonly autoApprove: boolean;
}

/** Read-only profile shared by refine, plan, readiness. */
export const READ_ONLY: SessionPermissions = {
  canEditFiles: false,
  canRunShell: false,
  canAccessNetwork: true,
  autoApprove: false,
};

/** Full-auto profile used by the implement chain. */
export const FULL_AUTO: SessionPermissions = {
  canEditFiles: true,
  canRunShell: true,
  canAccessNetwork: true,
  autoApprove: true,
};
