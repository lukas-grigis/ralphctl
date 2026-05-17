import type { ArtifactRef, HookRef, NamedArtifactRef } from '@src/integration/ai/readiness/_engine/artifact-ref.ts';

/**
 * Catalog of Claude-Code-specific artifacts a probe can discover under a Repository.
 * Every field is optional except the `tool` discriminator; collections are arrays so an
 * empty collection ("checked, none present") is distinct from "field absent".
 */
export interface ClaudeArtifacts {
  readonly tool: 'claude-code';
  /** Project-level memory at repo root. */
  readonly claudeMd?: ArtifactRef;
  /** Cross-tool spec; also read by Claude. */
  readonly agentsMd?: ArtifactRef;
  /** `.claude/settings.json` (project permissions, hook config, etc.). */
  readonly settings?: ArtifactRef;
  /** `.claude/settings.local.json` (per-machine overrides). */
  readonly settingsLocal?: ArtifactRef;
  /** Project-level MCP-server config at repo root. */
  readonly mcpConfig?: ArtifactRef;
  /** `.claude/skills/<name>/SKILL.md`. */
  readonly skills: readonly NamedArtifactRef[];
  /** `.claude/commands/<name>.md`. */
  readonly commands: readonly NamedArtifactRef[];
  /** `.claude/agents/<name>.md` (subagents). */
  readonly agents: readonly NamedArtifactRef[];
  /** Hooks declared inside `settings.json` / `settings.local.json`. */
  readonly hooks: readonly HookRef[];
}
