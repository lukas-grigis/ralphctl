import type { ArtifactRef, NamedArtifactRef } from '@src/integration/ai/readiness/_engine/artifact-ref.ts';

/**
 * Catalog of Grok-specific artifacts a probe can discover under a Repository.
 *
 * Grok follows the cross-tool `AGENTS.md` convention for project context and keeps its own
 * `.grok/` tree for skills.
 */
export interface GrokArtifacts {
  readonly tool: 'grok';
  /** Project-level context memory at repo root. */
  readonly agentsMd?: ArtifactRef;
  /** `.grok/skills/<name>/SKILL.md`. */
  readonly skills: readonly NamedArtifactRef[];
}
