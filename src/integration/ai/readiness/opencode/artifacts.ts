import type { ArtifactRef, NamedArtifactRef } from '@src/integration/ai/readiness/_engine/artifact-ref.ts';

/**
 * Catalog of OpenCode-specific artifacts a probe can discover under a Repository.
 *
 * OpenCode follows the cross-tool `AGENTS.md` convention for project context — the same file
 * Codex reads — but keeps its own `.opencode/` tree for skills, so the two tools are NOT
 * interchangeable at the artifact level and each gets its own probe.
 */
export interface OpencodeArtifacts {
  readonly tool: 'opencode';
  /** Project-level context memory at repo root. */
  readonly agentsMd?: ArtifactRef;
  /** `.opencode/skills/<name>/SKILL.md`. */
  readonly skills: readonly NamedArtifactRef[];
}
