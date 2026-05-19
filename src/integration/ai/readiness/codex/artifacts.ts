import type { ArtifactRef, NamedArtifactRef } from '@src/integration/ai/readiness/_engine/artifact-ref.ts';

/**
 * Catalog of Codex-specific artifacts a probe can discover under a Repository.
 *
 * Today we treat `AGENTS.md` as the canonical project context file and
 * `.agents/skills/<name>/SKILL.md` as project-level skills. Both are used by the Codex flows:
 * readiness writes/updates `AGENTS.md`, and the skills adapter installs into `.agents/skills`.
 */
export interface CodexArtifacts {
  readonly tool: 'codex';
  /** Project-level context memory at repo root. */
  readonly agentsMd?: ArtifactRef;
  /** `.agents/skills/<name>/SKILL.md`. */
  readonly skills: readonly NamedArtifactRef[];
}
